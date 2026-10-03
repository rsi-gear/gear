"""Read-only API negotiation against the locked Slime checkout, without GPU imports.

This confirms the named upstream interfaces exist. It is not numerical/GPU
certification: the separate scoped runtime audit must cover loss and recovery.
"""
import ast
from pathlib import Path
from ..content import require
from .registry import estimator, is_sft


def verify_source_contract(directory, request):
    root = Path(directory)
    try:
        args_tree = ast.parse((root / "slime/utils/arguments.py").read_text())
        calls = [n for n in ast.walk(args_tree) if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr == "add_argument"]
        flags = {arg.value: call for call in calls for arg in call.args if isinstance(arg, ast.Constant) and isinstance(arg.value, str) and arg.value.startswith("--")}
        choice = next(k.value for k in flags["--advantage-estimator"].keywords if k.arg == "choices")
        require(estimator(request) in ast.literal_eval(choice), "unsupported-slime-algorithm", "pinned runtime does not expose the sealed advantage estimator")
        losses = ast.parse((root / "slime/backends/megatron_utils/loss.py").read_text())
        functions = {n.name for n in ast.walk(losses) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))}
        required = {"--loss-type", "--disable-compute-advantages-and-returns", "--debug-train-only", "--use-rollout-logprobs"}
        if estimator(request).startswith("reinforce_plus_plus"): required.update({"--normalize-advantages", "--disable-rewards-normalization", "--disable-grpo-std-normalization"})
        if is_sft(request):
            required.add("--disable-rollout-global-dataset")
            require("sft_loss_function" in functions, "unsupported-slime-algorithm", "pinned runtime does not expose supervised token loss")
            manager = (root / "slime/ray/rollout.py").read_text()
            placement = (root / "slime/ray/placement_group.py").read_text()
            require("if self.args.debug_train_only:" in manager and "self.servers: dict[str, Any] = {}" in manager
                    and "if args.debug_train_only:" in placement and "return actor_num_gpus, 0" in placement,
                    "unsupported-slime-sft-runtime", "actor-only data manager/placement interfaces are unavailable")
        else:
            require("policy_loss_function" in functions and "compute_advantages_and_returns" in functions,
                    "unsupported-slime-algorithm", "native policy loss/advantage API unavailable")
        require(required <= flags.keys(), "unsupported-slime-algorithm", "pinned runtime recipe flags are unavailable")
        return {"recipe": request["trainer"].get("recipe", "agent-grpo-v1"), "sourceApi": "verified", "gpuValidation": "unverified"}
    except (OSError, SyntaxError, KeyError, StopIteration, ValueError) as error:
        if getattr(error, "code", None): raise
        require(False, "unsupported-slime-algorithm", "cannot verify pinned Slime recipe API: " + type(error).__name__)
