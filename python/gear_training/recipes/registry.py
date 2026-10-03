"""Versioned recipes over the actual pinned Slime loss/advantage APIs."""
from ..content import require

ESTIMATORS = {
    "agent-grpo-v1": "grpo", "agent-gspo-v1": "gspo", "agent-cispo-v1": "cispo",
    "agent-reinforce-plus-plus-v1": "reinforce_plus_plus",
    "agent-reinforce-plus-plus-baseline-v1": "reinforce_plus_plus_baseline",
    "offline-sft-v1": "grpo",  # ignored when compute_advantages_and_returns is disabled
}


def estimator(request):
    name = request["trainer"].get("recipe", "agent-grpo-v1")
    require(name in ESTIMATORS, "unsupported-training-recipe", "unknown versioned training recipe: " + str(name))
    return ESTIMATORS[name]


def is_sft(request):
    estimator(request)
    return request["trainer"].get("recipe") == "offline-sft-v1"


def zero_variance_policy(request):
    return "keep" if estimator(request) == "reinforce_plus_plus" else request["rollout"]["zeroVarianceGroup"]


def validate_recipe_args(args, request):
    require(getattr(args, "loss_type", "policy_loss") == ("sft_loss" if is_sft(request) else "policy_loss"),
            "slime-recipe-drift", "Slime loss differs from the sealed recipe")
    require(not getattr(args, "use_opd", False) and not getattr(args, "use_critic", False)
            and not getattr(args, "use_tis", False), "unsupported-training-extension", "OPD, critic and asynchronous correction are outside these recipes")
    if estimator(request).startswith("reinforce_plus_plus"):
        require(args.normalize_advantages, "slime-recipe-drift", "REINFORCE++ requires native masked advantage normalization")
    if estimator(request) == "reinforce_plus_plus":
        require(not args.rewards_normalization, "slime-recipe-drift", "REINFORCE++ uses uncentered scalar rewards")
    elif estimator(request) == "reinforce_plus_plus_baseline":
        require(args.rewards_normalization and not args.grpo_std_normalization, "slime-recipe-drift", "REINFORCE++ baseline centers groups without GRPO std scaling")
    if is_sft(request):
        sequence_length = getattr(args, "seq_length", None)
        if sequence_length is not None:
            require(request["offlineTraining"]["maxSequenceTokens"] <= sequence_length,
                    "offline-context-overflow", "SFT maximum sequence exceeds actual Megatron sequence length")
        require(args.debug_train_only and not args.compute_advantages_and_returns and not args.use_rollout_logprobs
                and args.kl_coef == 0 and not args.use_kl_loss and args.kl_loss_coef == 0,
                "slime-recipe-drift", "offline SFT requires actor-only supervised loss with no rollout or reference KL")
