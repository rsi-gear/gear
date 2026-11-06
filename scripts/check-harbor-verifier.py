"""Run a synthetic candidate and frozen scorer in separate real Harbor containers.

Run with Harbor 0.21's Python, --hitch-integrations pointing at Hitch's compatible
integrations/harbor directory, --image pinned to a Python OCI digest, and a fresh
--output directory. No credentials or model calls are needed. Evidence is retained.
"""

import argparse
import asyncio
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
sys.path.insert(0, str(args.hitch_integrations.resolve()))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "python"))
from gear.benchmark import compile_benchmark
from gear.benchmark.harbor import compile_harbor
from harbor.models.trial.config import TrialConfig
from harbor.trial.trial import Trial

IMAGE = args.image
root = args.output.resolve()
root.mkdir(parents=True, exist_ok=False)
suffix = uuid.uuid4().hex
identifier = "gear-probe-" + suffix[:12]
(root / "tasks.jsonl").write_text(
    json.dumps(
        {
            "id": identifier,
            "instruction": "Write the fixture output.",
            "expected": "correct",
            "split": "seed",
        }
    )
)
(root / "scorers.py").write_text("""import socket
from pathlib import Path
def score(actual, expected, artifacts, *, seed):
    assert artifacts['proof.txt'] != socket.gethostname(), 'shared verifier hostname'
    assert not Path('/tmp/candidate-only-sentinel').exists(), 'shared candidate filesystem'
    assert len(Path('/proc/net/route').read_text().splitlines()) == 1, 'verifier has an external route'
    return actual == expected
""")
config = {
    "version": 1,
    "source": "tasks.jsonl",
    "template": "python",
    "scorer": {
        "entrypoint": "scorers.py:score",
        "version": "v1",
        "randomness": {"seed": 7},
        "cost": {"model_requests": 0},
        "artifacts": ["proof.txt"],
    },
    "fixtures": {
        identifier: [
            {
                "actual": "correct",
                "artifacts": {"proof.txt": "fixture-host"},
                "score": 1,
            },
            {"actual": "wrong", "artifacts": {"proof.txt": "fixture-host"}, "score": 0},
        ]
    },
}
benchmark = compile_benchmark(root, config)
compile_harbor(benchmark, str(root / "tasks"), [identifier], IMAGE)
(root / "gear_fixture_agent.py").write_text("""import shlex
from harbor.agents.nop import NopAgent
from hitch_harbor_environment import HitchHarborDockerEnvironment
ENVS=[]
class Environment(HitchHarborDockerEnvironment):
    def __init__(self,*args,**kwargs):
        super().__init__(*args,**kwargs)
        ENVS.append(self)
class Agent(NopAgent):
    def __init__(self,*args,actual,**kwargs):
        super().__init__(*args,**kwargs)
        self.actual=actual
    async def run(self,instruction,environment,context):
        code="from pathlib import Path;import socket;assert not Path('/tests/expected.json').exists();Path('/app/answer.txt').write_text("+repr(self.actual)+");Path('/app/proof.txt').write_text(socket.gethostname());Path('/tmp/candidate-only-sentinel').touch()"
        result=await environment.exec('python3 -c '+shlex.quote(code),timeout_sec=10)
        if result.return_code: raise RuntimeError(result.stderr)
""")
sys.path.insert(0, str(root))
import gear_fixture_agent

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
        for actual, score in [("correct", 1), ("wrong", 0)]:
            config = TrialConfig.model_validate(
                {
                    "task": {"path": str(root / "tasks" / identifier)},
                    "trial_name": identifier + "-" + actual,
                    "trials_dir": str(root / "trials"),
                    "agent": {
                        "import_path": "gear_fixture_agent:Agent",
                        "kwargs": {"actual": actual},
                    },
                    "environment": {
                        "import_path": "gear_fixture_agent:Environment",
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
            if result.verifier_result.rewards != {"reward": float(score)}:
                raise AssertionError(result.verifier_result)
        report["passed"] = True
    finally:
        errors = []
        for env in gear_fixture_agent.ENVS:
            try:
                await env.stop(delete=True)
            except Exception as e:
                errors.append(type(e).__name__)
        for name in set(env._main_image_name for env in gear_fixture_agent.ENVS):
            removed = subprocess.run(
                ["docker", "image", "rm", name],
                capture_output=True,
                text=True,
                timeout=30,
            )
            if removed.returncode and "No such image" not in removed.stderr:
                errors.append("image:" + name)
        left = subprocess.check_output(
            [
                "docker",
                "ps",
                "-aq",
                "--filter",
                "label=io.hitch.lease-id=lease_" + suffix,
            ],
            text=True,
            timeout=30,
        ).strip()
        report["remaining_containers"] = left.splitlines()
        report["cleanup_errors"] = errors
        report["passed"] = report.get("passed", False) and not left and not errors
        (root / "report.json").write_text(json.dumps(report, indent=2))
        print(
            json.dumps(
                {
                    "report": str(root / "report.json"),
                    "passed": report.get("passed", False),
                    "model_calls": 0,
                    "remaining_containers": report["remaining_containers"],
                    "cleanup_errors": errors,
                }
            )
        )
        if left or errors:
            raise RuntimeError("cleanup unconfirmed")


asyncio.run(main())
