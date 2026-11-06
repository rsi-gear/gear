"""Exercise imported Compose, simulator artifacts and separate scores using real Harbor; no model."""

import argparse
import asyncio
import base64
import json
import subprocess
import sys
import uuid
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--hitch-integrations", required=True, type=Path)
parser.add_argument("--image", required=True)
parser.add_argument("--output", required=True, type=Path)
args = parser.parse_args()
sys.path[:0] = [
    str(args.hitch_integrations.resolve()),
    str(Path(__file__).resolve().parents[1] / "python"),
]
from gear.benchmark import compile_benchmark
from gear.benchmark.harbor import compile_harbor
from gear.benchmark.importer import prepare_import
from gear.benchmark.manifest import build_manifest
from gear.benchmark.native import native_tasks
from harbor.models.trial.config import TrialConfig
from harbor.trial.trial import Trial

root = args.output.resolve()
root.mkdir(parents=True, exist_ok=False)
suffix = uuid.uuid4().hex
identifier = "native-" + suffix[:12]
source = root / "source"
task = source / identifier
for relative in ("environment/candidate", "environment/simulator", "tests"):
    (task / relative).mkdir(parents=True)
(task / "instruction.md").write_text(
    "Write the simulator state through its HTTP endpoint."
)
(task / "task.toml").write_text("""version="1.0"
artifacts=[{source="/evidence/snapshot.json",service="simulator"}]
[environment]
network_mode="public"
[verifier]
environment_mode="separate"
[verifier.environment]
network_mode="no-network"
""")
(task / "environment/candidate/Dockerfile.main").write_text(
    f"FROM {args.image}\nWORKDIR /app\n"
)
(task / "environment/simulator/Dockerfile").write_text(
    f'FROM {args.image}\nCOPY server.py /server.py\nCMD ["python3", "/server.py"]\n'
)
(task / "environment/simulator/server.py").write_text("""import json,socket
from pathlib import Path
from http.server import BaseHTTPRequestHandler,HTTPServer
from urllib.parse import urlparse,parse_qs
class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        query=parse_qs(urlparse(self.path).query)
        if "value" in query:
            Path("/evidence").mkdir(exist_ok=True)
            Path("/evidence/snapshot.json").write_text(json.dumps({"value":query["value"][0],"hostname":socket.gethostname()}))
        self.send_response(200);self.end_headers();self.wfile.write(b"ok")
HTTPServer(("0.0.0.0",8765),Handler).serve_forever()
""")
(task / "environment/docker-compose.yaml").write_text(
    json.dumps(
        {
            "services": {
                "main": {
                    "platform": "linux/amd64",
                    "build": {"context": "candidate", "dockerfile": "Dockerfile.main"},
                    "depends_on": {"simulator": {"condition": "service_healthy"}},
                },
                "simulator": {
                    "platform": "linux/amd64",
                    "build": {"context": "simulator"},
                    "healthcheck": {
                        "test": [
                            "CMD",
                            "python3",
                            "-c",
                            "import urllib.request;urllib.request.urlopen('http://localhost:8765')",
                        ],
                        "interval": "1s",
                        "timeout": "3s",
                        "retries": 20,
                    },
                },
            }
        }
    )
)
(task / "tests/Dockerfile").write_text(
    f'FROM {args.image}\nCOPY . /tests\nCMD ["sleep", "infinity"]\n'
)
(task / "tests/test.sh").write_text("#!/bin/sh\nset -eu\npython3 /tests/verify.py\n")
(task / "tests/test.sh").chmod(0o755)
(task / "tests/verify.py").write_text("""import json,socket
from pathlib import Path
snapshot=json.loads(Path("/evidence/snapshot.json").read_text())
assert snapshot["hostname"] != socket.gethostname()
assert not Path("/tmp/candidate-only-sentinel").exists()
assert len(Path("/proc/net/route").read_text().splitlines()) == 1
correct=snapshot["value"] == "correct"
score=(1+int(correct))/2
logs=Path("/logs/verifier");logs.mkdir(parents=True,exist_ok=True)
(logs/"reward.json").write_text(json.dumps({"reward":int(correct),"total_score":int(correct),"process_score":score}))
(logs/"process.json").write_text(json.dumps({"schema_version":"1","metric":"partial_credit","score":score,"detail_status":"components","passed":1+int(correct),"total":2,"excluded":0,"components":[{"id":"state","category":"state","code":"state","status":"passed" if correct else "failed","weight":1},{"id":"simulator","category":"state","code":"simulator","status":"passed","weight":1}]}))
""")
entries, _, _ = native_tasks(source)
score = lambda metric: {
    "source_metric": metric,
    "direction": "maximize",
    "range": [0, 1],
    "reducer": "task-macro-mean",
}
manifest = build_manifest(
    {
        "schema_version": "1",
        "kind": "gear-harbor-benchmark",
        "benchmark": {"id": "native-compose-probe", "revision": suffix},
        "adapter": {
            "id": "fixture-producer",
            "revision": suffix,
            "output_protocol": "gear-harbor-eval-result-v1",
        },
        "scoring": {
            "total_score": score("correct"),
            "process_score": score("partial_credit"),
        },
    },
    [{"id": entry["task"]["id"], "files": entry["files"]} for entry in entries],
)
(source / "benchmark.adapter.json").write_text(json.dumps(manifest))
(source / "source-manifest.json").write_text(
    json.dumps({"schema_version": "1", "source_commit": suffix})
)
plan = prepare_import(str(source), template="harbor", mode="research")
for file in plan["files"]:
    output = root / plan["directory"] / file["path"]
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(base64.b64decode(plan["blobs"][file["digest"]]))
    output.chmod(0o755 if file["executable"] else 0o644)
benchmark = compile_benchmark(root, plan["config"])
compile_harbor(benchmark, str(root / "tasks"), [identifier], args.image)
(root / "gear_native_fixture_agent.py").write_text("""import shlex
from harbor.agents.nop import NopAgent
from hitch_harbor_environment import HitchHarborDockerEnvironment
from harbor.environments.docker.docker import _sanitize_docker_compose_project_name
ENVS=[]
IMAGES=set()
class Environment(HitchHarborDockerEnvironment):
    def __init__(self,*args,**kwargs):
        super().__init__(*args,**kwargs)
        ENVS.append(self)
        IMAGES.update([self._main_image_name, _sanitize_docker_compose_project_name(self.session_id)+"-simulator"])
class Agent(NopAgent):
    def __init__(self,*args,actual,**kwargs):
        super().__init__(*args,**kwargs)
        self.actual=actual
    async def run(self,instruction,environment,context):
        code="from pathlib import Path;import urllib.request;assert not Path('/tests/verify.py').exists();Path('/tmp/candidate-only-sentinel').touch();urllib.request.urlopen('http://simulator:8765/?value='+"+repr(self.actual)+").read()"
        result=await environment.exec('python3 -c '+shlex.quote(code),timeout_sec=15)
        if result.return_code: raise RuntimeError(result.stderr)
""")
sys.path.insert(0, str(root))
import gear_native_fixture_agent

labels = {
    "io.hitch.root-id": suffix[:24],
    "io.hitch.provider": "local-docker",
    "io.hitch.eval-id": "eval_" + suffix,
    "io.hitch.work-id": "work_" + suffix,
    "io.hitch.lease-id": "lease_" + suffix,
    "io.hitch.lease-epoch": "1",
    "io.hitch.task-id": identifier,
}


async def main():
    report = {
        "schema_version": 1,
        "root": str(root),
        "synthetic_candidate": True,
        "model_calls": 0,
        "results": [],
    }
    try:
        for actual, total, process in [("correct", 1, 1), ("wrong", 0, 0.5)]:
            config = TrialConfig.model_validate(
                {
                    "task": {"path": str(root / "tasks" / identifier)},
                    "trial_name": identifier + "-" + actual,
                    "trials_dir": str(root / "trials"),
                    "agent": {
                        "import_path": "gear_native_fixture_agent:Agent",
                        "kwargs": {"actual": actual},
                    },
                    "environment": {
                        "import_path": "gear_native_fixture_agent:Environment",
                        "delete": True,
                        "kwargs": {"hitch_ownership_labels": labels},
                    },
                }
            )
            trial = await Trial.create(config)
            result = await asyncio.wait_for(trial.run(), timeout=180)
            report["results"].append(result.model_dump(mode="json"))
            if result.exception_info:
                raise RuntimeError(str(result.exception_info))
            if result.verifier_result.rewards != {
                "reward": float(total),
                "total_score": float(total),
                "process_score": process,
            }:
                raise AssertionError(result.verifier_result)
        report["passed"] = True
    finally:
        errors = []
        for env in gear_native_fixture_agent.ENVS:
            try:
                await env.stop(delete=True)
            except Exception as error:  # noqa: BLE001 - report every backend cleanup failure
                errors.append(type(error).__name__)
        for name in gear_native_fixture_agent.IMAGES:
            removed = await asyncio.to_thread(
                subprocess.run,
                ["docker", "image", "rm", name],
                capture_output=True,
                text=True,
                timeout=30,
                check=False,
            )
            if removed.returncode and "No such image" not in removed.stderr:
                errors.append("image:" + name)
        left = (
            await asyncio.to_thread(
                subprocess.check_output,
                [
                    "docker",
                    "ps",
                    "-aq",
                    "--filter",
                    "label=io.hitch.lease-id=lease_" + suffix,
                ],
                text=True,
                timeout=30,
            )
        ).strip()
        report.update(remaining_containers=left.splitlines(), cleanup_errors=errors)
        report["passed"] = report.get("passed", False) and not left and not errors
        (root / "report.json").write_text(json.dumps(report, indent=2))
        print(
            json.dumps(
                {
                    "report": str(root / "report.json"),
                    "passed": report["passed"],
                    "model_calls": 0,
                    "remaining_containers": left.splitlines(),
                    "cleanup_errors": errors,
                }
            )
        )
        if left or errors:
            raise RuntimeError("cleanup unconfirmed")


asyncio.run(main())
