"""Create one stable local campaign; rerunning keeps its identity and checkpoint key."""
import json
import os
import secrets
import sys
import tempfile
import uuid
from pathlib import Path

root = Path(__file__).resolve().parent
config_path = root / "gear.algorithm.json"
key_path = root / "checkpoint.key"
if config_path.exists():
    if not key_path.is_file() or len(key_path.read_bytes()) != 32:
        raise SystemExit("Existing campaign config has no valid checkpoint.key; restore its original key")
    print(f"Using existing {config_path}")
    raise SystemExit(0)
if not key_path.exists():
    try:
        descriptor = os.open(key_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        pass
    else:
        with os.fdopen(descriptor, "wb") as output:
            output.write(secrets.token_bytes(32))
            output.flush()
            os.fsync(output.fileno())
if not key_path.is_file() or len(key_path.read_bytes()) != 32:
    raise SystemExit("Existing checkpoint.key is invalid; refusing to replace it")
campaign_id = f"optuna-cpu-{uuid.uuid4()}"
entry = {"language": "python", "interpreter": sys.executable,
         "module": "./providers.py", "resources": ["checkpoint.key"]}
config = {
    "schemaVersion": 1, "kind": "algorithm-campaign", "campaignId": campaign_id,
    "stateDir": f"./.gear/{campaign_id}",
    "algorithm": {"language": "python", "interpreter": sys.executable,
                  "module": "gear_algorithm.recipes.optuna_search", "export": "algorithm"},
    "config": {"studyName": campaign_id, "direction": "minimize", "sampler": "random",
               "seed": 17, "space": {"x": {"type": "float", "low": -1, "high": 1}},
               "trials": 2, "evaluationKind": "experiment.evaluate",
               "operationLimits": {"experiment.evaluate": {"evaluation.calls": 1}}},
    "bindings": {}, "budget": {"evaluation.calls": {
        "unit": "call", "limit": 2, "source": "experiment.evaluate", "capability": "stop"}},
    "providers": [{**entry, "export": "ask_provider"},
                  {**entry, "export": "tell_provider"},
                  {**entry, "export": "evaluate_provider"}],
}
with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=root,
                                 prefix=".gear.algorithm.", delete=False) as output:
    temporary_path = Path(output.name)
    output.write(json.dumps(config, indent=2) + "\n")
    output.flush()
    os.fsync(output.fileno())
try:
    # The link publishes a fully written config exclusively. A crash before it
    # leaves the existing key intact and no partial campaign configuration.
    os.link(temporary_path, config_path)
    directory = os.open(root, os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)
finally:
    temporary_path.unlink(missing_ok=True)
print(f"Created {config_path}")
