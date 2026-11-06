"""Opt-in real Docker check with a caller-owned, loopback-only test registry."""

import concurrent.futures
import json
import os
import subprocess
import tempfile
import unittest
import uuid
from pathlib import Path

from test_native_environment import manifest
from test_shared_runtime import BASE, fixture

from gear.benchmark import compile_benchmark
from gear.benchmark.harbor import compile_harbor
from gear.benchmark.shared_runtime import bind, prepare


@unittest.skipUnless(os.environ.get("GEAR_SHARED_RUNTIME_DOCKER_TEST") == "1", "requires Docker")
class SharedRuntimeDockerTests(unittest.TestCase):
    def test_image_files_configuration_and_writable_layers_are_equivalent_and_isolated(self):
        registry = os.environ["GEAR_SHARED_RUNTIME_TEST_REGISTRY"]
        if not registry.startswith("127.0.0.1:") or not registry.split(":")[1].isdigit():
            self.fail("use a caller-owned loopback registry")
        base = os.environ["GEAR_SHARED_RUNTIME_TEST_IMAGE"]
        prefix = registry + "/gear-shared-test-" + uuid.uuid4().hex
        tags = []

        def docker(*args):
            return subprocess.check_output(["docker", *args], text=True, timeout=180)

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source"
            plan = fixture(source)
            for file in source.glob("*/**/Dockerfile"):
                file.write_text(
                    file.read_text()
                    .replace(BASE, base)
                    .replace(
                        "COPY src /code\n",
                        "RUN mkdir -p /code && echo original > /other "
                        "&& ln -s /other /code/row.json\nCOPY src /code\n",
                    )
                )
            for build in plan["builds"]:
                build["prefix_lines"] = 3
            (source / "benchmark.adapter.json").unlink()
            manifest(source)
            # Compare actual Gear execution inputs. Native admission preserves
            # executable bits; compile_harbor normalizes files to 0644/0755.
            # Building the raw author directory would compare a different mode
            # contract (e.g. 0664 from the caller's umask) with that execution.
            benchmark = compile_benchmark(
                root, {"version": 1, "template": "harbor", "source": "source"}
            )
            source = root / "baseline"
            compile_harbor(benchmark, str(source), plan["tasks"], base)
            record = prepare(source, plan, root / "prepared")
            images = {}
            try:
                for key in record["recipes"]:
                    tag = prefix + ":" + key.split(":")[1]
                    tags.append(tag)
                    docker(
                        "build",
                        "--provenance=false",
                        "--platform",
                        "linux/amd64",
                        "-t",
                        tag,
                        str(root / "prepared/contexts" / key.split(":")[1]),
                    )
                    docker("push", tag)
                    info = json.loads(docker("image", "inspect", tag))[0]
                    images[key] = next(
                        ref for ref in info["RepoDigests"] if ref.startswith(prefix + "@")
                    )
                bind(root / "prepared", images, root / "shared")
                benchmark = compile_benchmark(
                    root, {"version": 1, "template": "harbor", "source": "shared"}
                )
                compile_harbor(benchmark, str(root / "shared-execution"), plan["tasks"], base)
                probe = """import hashlib,json,pathlib,stat
p=pathlib.Path('/code')
assert not (p/'row.json').is_symlink()
assert pathlib.Path('/other').read_text() == 'original\\n'
rows=[]
for f in sorted(p.rglob('*')):
 rows.append([str(f.relative_to(p)),stat.S_IMODE(f.stat().st_mode),
              hashlib.sha256(f.read_bytes()).hexdigest() if f.is_file() else None])
print(json.dumps(rows))
(p/'module.py').write_text('private mutation')
(p/'created-by-this-container').write_text('private')
"""
                built = {}
                for task in plan["tasks"]:
                    for mode, dataset in (
                        ("baseline", source),
                        ("shared", root / "shared-execution"),
                    ):
                        tag = prefix + ":" + task + "-" + mode
                        tags.append(tag)
                        docker(
                            "build",
                            "--provenance=false",
                            "--platform",
                            "linux/amd64",
                            "-t",
                            tag,
                            str(dataset / task / "environment"),
                        )
                        built[task, mode] = tag
                    before, after = [
                        json.loads(docker("image", "inspect", built[task, mode]))[0]
                        for mode in ("baseline", "shared")
                    ]
                    for key in ("Env", "Cmd", "WorkingDir", "Entrypoint", "User"):
                        self.assertEqual(before["Config"].get(key), after["Config"].get(key))
                    baseline = docker(
                        "run",
                        "--rm",
                        "--network",
                        "none",
                        built[task, "baseline"],
                        "python",
                        "-c",
                        probe,
                    )
                    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
                        results = list(
                            pool.map(
                                lambda _: docker(
                                    "run",
                                    "--rm",
                                    "--network",
                                    "none",
                                    built[task, "shared"],
                                    "python",
                                    "-c",
                                    probe,
                                ),
                                range(4),
                            )
                        )
                    self.assertEqual(results, [baseline] * 4)
            finally:
                for tag in reversed(tags):
                    subprocess.run(["docker", "image", "rm", tag], capture_output=True, timeout=60)


if __name__ == "__main__":
    unittest.main()
