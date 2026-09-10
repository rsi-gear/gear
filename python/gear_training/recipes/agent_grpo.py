from ..content import require


def sampling_params(rollout):
    s = rollout["sampling"]
    require((s["temperature"], s["topP"], s["topK"], s["repetitionPenalty"]) == (1, 1, -1, 1), "unsupported-sampling", "v1 does not support nucleus replay or modified behavior distributions")
    return {"temperature": 1, "top_p": 1, "top_k": -1, "repetition_penalty": 1,
            "max_new_tokens": s["maxNewTokens"], "skip_special_tokens": False,
            "spaces_between_special_tokens": False, "no_stop_trim": True}


def effective_sampling(locked, body, input_length, max_context):
    require(isinstance(body, dict), "invalid-request", "generation request must be an object")
    for key in ("temperature", "top_p", "top_k", "repetition_penalty"):
        require(key not in body or body[key] == locked[key], "sampling-conflict", "Harness cannot override locked sampling: " + key)
    # Unsupported sampling controls must not silently alter the behavior policy.
    for key in ("min_p", "frequency_penalty", "presence_penalty", "logit_bias", "seed", "stop", "stop_token_ids", "n", "best_of"):
        require(key not in body, "unsupported-sampling-control", "unsealed sampling control: " + key)
    result = dict(locked)
    for key in ("max_tokens", "max_completion_tokens", "max_output_tokens"):
        if key in body:
            require(type(body[key]) is int and 0 < body[key] <= locked["max_new_tokens"], "sampling-budget-conflict", "output limit may only tighten the sealed maximum")
            result["max_new_tokens"] = min(result["max_new_tokens"], body[key])
    available = max_context - input_length
    require(available > 0, "context-exhausted", "prompt exhausted the context budget")
    result["max_new_tokens"] = min(result["max_new_tokens"], available)
    return result


def validate_layout(args, request):
    t, r = request["trainer"], request["rollout"]
    for key, expected in {"rollout_batch_size": t["rolloutBatchSize"], "n_samples_per_prompt": r["groupSize"], "global_batch_size": t["globalBatchSize"], "advantage_estimator": "grpo"}.items():
        require(getattr(args, key, None) == expected, "slime-recipe-drift", "Slime argument conflicts with sealed recipe: " + key)
    total = t["rolloutBatchSize"] * r["groupSize"]
    require(total % t["globalBatchSize"] == 0 and t["globalBatchSize"] % t["dataParallelSize"] == 0, "invalid-batch-layout", "B × G / global batch / DP divisibility failed")
    require(not getattr(args, "dynamic_global_batch_size", False), "dynamic-batching-unsupported", "fixed groups cannot use dynamic global batching")
    sampling_params(r)
