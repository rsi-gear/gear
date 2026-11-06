"""Thin Supervisor client. Supervisor owns spawning, logs and process-group stops."""

from __future__ import annotations

import http.client
import os
import shlex
import socket
import subprocess
import time
import xmlrpc.client
from pathlib import Path

from gear.training.storage.content import digest_bytes, require, sync_dir


class UnixConnection(http.client.HTTPConnection):
    def __init__(self, path):
        super().__init__("localhost", timeout=5)
        self.path = str(path)

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.path)


class UnixTransport(xmlrpc.client.Transport):
    def __init__(self, path):
        super().__init__()
        self.path = path

    def make_connection(self, host):
        if self._connection and self._connection[0] == host:
            return self._connection[1]
        self._connection = host, UnixConnection(self.path)
        return self._connection[1]


def private_text(path, value):
    """Exclusive immutable configuration publication with private permissions."""
    path = Path(path)
    if path.exists():
        require(
            path.is_file() and not path.is_symlink() and path.read_text() == value,
            "deployment-config-drift",
            "native process-manager configuration changed",
        )
        return
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as f:
        f.write(value)
        f.flush()
        os.fsync(f.fileno())
    sync_dir(path.parent)


class SupervisorBackend:
    def __init__(self, directory, profile, manager_id):
        self.root = Path(directory)
        self.profile = profile
        self.manager_id = manager_id
        self.socket = self.root / "supervisor.sock"
        self.config = self.root / "supervisord.ini"
        self.transport = UnixTransport(self.socket)
        self.rpc = xmlrpc.client.ServerProxy(
            "http://localhost", transport=self.transport, allow_none=True
        ).supervisor

    def close(self):
        self.transport.close()

    def render_manager(self):
        root = str(self.root)
        require(
            not any(c in root for c in "\n\r;#%"),
            "unsafe-deployment-directory",
            "native process-manager path cannot contain configuration syntax",
        )
        return (
            f"[unix_http_server]\nfile={self.socket}\nchmod=0600\n"
            f"[supervisord]\nidentifier={self.manager_id}\npidfile={root}/supervisord.pid\n"
            f"logfile={root}/supervisord.log\nlogfile_maxbytes=5MB\nlogfile_backups=2\n"
            "umask=077\nminfds=128\nminprocs=16\n"
            "[rpcinterface:supervisor]\nsupervisor.rpcinterface_factory=supervisor.rpcinterface:make_main_rpcinterface\n"
            f"[include]\nfiles={root}/programs/*.ini\n"
        )

    def observe_manager(self):
        try:
            info = self.socket.lstat()
        except FileNotFoundError:
            return False
        require(
            self.socket.is_socket() and info.st_uid == os.getuid() and info.st_mode & 0o077 == 0,
            "deployment-manager-ownership",
            "Supervisor socket is not private to this owner",
        )
        require(
            self.rpc.getIdentification() == self.manager_id,
            "deployment-manager-ownership",
            "Supervisor belongs to another resource group",
        )
        import psutil

        manager = psutil.Process(self.rpc.getPID())
        expected = [
            self.profile["supervisorPython"],
            "-m",
            "supervisor.supervisord",
            "-c",
            str(self.config),
        ]
        require(
            manager.uids().real == os.getuid() and manager.cmdline() == expected,
            "deployment-manager-ownership",
            "Supervisor running command differs from its ownership record",
        )
        return True

    def ensure_manager(self):
        (self.root / "programs").mkdir(parents=True, exist_ok=True, mode=0o700)
        private_text(self.config, self.render_manager())
        try:
            if self.observe_manager():
                return
        except (ConnectionRefusedError, FileNotFoundError):
            # The private config/socket alone do not prove the old manager died.
            # Require a recorded PID and prove that exact PID absent first.
            import psutil

            pidfile = self.root / "supervisord.pid"
            require(
                pidfile.is_file() and not pidfile.is_symlink(),
                "deployment-manager-uncertain",
                "stale Supervisor socket has no death evidence",
            )
            require(
                not psutil.pid_exists(int(pidfile.read_text().strip())),
                "deployment-manager-uncertain",
                "Supervisor socket is unavailable while its recorded PID exists",
            )
            self.socket.unlink(missing_ok=True)
        pidfile = self.root / "supervisord.pid"
        if pidfile.exists():
            import psutil

            pid = int(pidfile.read_text().strip())
            require(
                not psutil.pid_exists(pid),
                "deployment-manager-uncertain",
                "Supervisor PID exists without a verified socket; preserve it for reconciliation",
            )
        result = subprocess.run(
            [
                self.profile["supervisorPython"],
                "-m",
                "supervisor.supervisord",
                "-c",
                str(self.config),
            ],
            capture_output=True,
            timeout=15,
            check=False,
        )
        require(
            result.returncode == 0,
            "deployment-manager-start-failed",
            "Supervisor could not start; inspect its private log",
        )
        require(
            self.observe_manager(),
            "deployment-manager-start-failed",
            "Supervisor did not publish its owned socket",
        )

    def configure(self, record):
        name = record["program"]
        command = " ".join(shlex.quote(arg) for arg in record["argv"])
        environment = {
            "CUDA_VISIBLE_DEVICES": ",".join(self.profile["gpuUuids"]),
            "GEAR_NATIVE_INCARNATION": record["incarnation"],
            "GEAR_NATIVE_INTENT": record["intentDigest"],
            "PYTHONUNBUFFERED": "1",
        }
        env = ",".join(f'{key}="{value}"' for key, value in environment.items())
        text = (
            f"[program:{name}]\ncommand={command}\ndirectory={record['snapshotPath']}\n"
            "autostart=false\nautorestart=false\nstartsecs=0\nstartretries=0\n"
            f"stopwaitsecs={self.profile['stopTimeoutSeconds']}\nstopsignal=KILL\nstopasgroup=true\nkillasgroup=true\n"
            f"environment={env}\numask=077\nredirect_stderr=true\n"
            f"stdout_logfile={self.root}/{name}.log\nstdout_logfile_maxbytes=10MB\nstdout_logfile_backups=2\n"
        )
        private_text(self.root / "programs" / (name + ".ini"), text)
        self.rpc.reloadConfig()
        try:
            self.rpc.getProcessInfo(name)
        except xmlrpc.client.Fault as error:
            require(
                error.faultCode == 10,
                "deployment-manager-error",
                "Supervisor could not inspect the owned program",
            )
            self.rpc.addProcessGroup(name)
        return digest_bytes(text.encode())

    def inspect(self, name):
        if not self.observe_manager():
            return None
        try:
            return self.rpc.getProcessInfo(name)
        except xmlrpc.client.Fault as error:
            require(
                error.faultCode == 10,
                "deployment-manager-error",
                "Supervisor could not inspect the owned program",
            )
            return None

    def start(self, name):
        self.rpc.startProcess(name, False)

    def stop(self, name):
        info = self.inspect(name)
        if info and info["statename"] in ("STARTING", "RUNNING", "BACKOFF"):
            self.rpc.stopProcess(name, False)

    def await_stopped(self, name, deadline):
        while time.time() < deadline:
            info = self.inspect(name)
            if not info or info["statename"] in ("STOPPED", "EXITED", "FATAL", "UNKNOWN"):
                return info
            time.sleep(0.05)
        return self.inspect(name)
