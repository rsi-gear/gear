"""Trusted, standard-library-only TRACE game driver, executed inside the CPU container.

Generated modules implement the chat/tool game contract. The host never imports
them, and only model-visible snapshots are used as solver input.
"""

import importlib.util
import json
import math
import resource
import sys


def load_game():
    spec = importlib.util.spec_from_file_location("generated_capability", "/input/environment.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def snapshot(game):
    prompt, tools, messages = game.get_system_prompt(), game.get_tool_schemas(), game.get_messages()
    if not isinstance(prompt, str) or not prompt.strip():
        raise ValueError("game must supply a nonempty system prompt")
    if not isinstance(tools, list) or not tools or not isinstance(messages, list) or not messages:
        raise ValueError("game must supply tools and an initial conversation")
    if type(game.done) is not bool or not isinstance(game._conversation, list):
        raise ValueError("game requires explicit done and raw conversation fields")
    maximum = getattr(game, "max_steps", getattr(game, "_max_steps", None))
    if type(maximum) is not int or not 1 <= maximum <= 64:
        raise ValueError("game max_steps must be an integer in [1, 64]")
    summary = game.get_summary()
    if not isinstance(summary, dict) or not {"reward", "steps"} <= set(summary):
        raise ValueError("game summary requires reward and steps")
    reward = summary["reward"]
    if type(reward) not in (int, float) or not math.isfinite(reward) or not 0 <= reward <= 1:
        raise ValueError("game reward must be finite and normalized; unknown is not zero")
    if type(summary["steps"]) is not int or not 0 <= summary["steps"] <= 64:
        raise ValueError("game summary requires a bounded step count")
    value = {
        "system_prompt": prompt,
        "tools": tools,
        "messages": messages,
        "done": game.done,
        "max_steps": maximum,
        "summary": summary,
        "conversation": game._conversation,
    }
    return json.loads(json.dumps(value, ensure_ascii=False, allow_nan=False))


def execute(module, seed, actions):
    game = module.CapabilityGame()
    game.reset(seed)
    snapshots = [snapshot(game)]
    for action in actions:
        if game.done:
            raise ValueError("cannot execute actions after episode termination")
        if len(snapshots) - 1 >= snapshots[0]["max_steps"]:
            raise ValueError("reference exceeds the declared environment step limit")
        if (
            set(action) != {"name", "arguments"}
            or not isinstance(action["name"], str)
            or not isinstance(action["arguments"], dict)
        ):
            raise ValueError("actions must be concrete names and JSON arguments")
        game.step(json.dumps(action, allow_nan=False))
        current = snapshot(game)
        if current["summary"]["steps"] != len(snapshots):
            raise ValueError("environment step count differs from executed action count")
        snapshots.append(current)
    return snapshots


def main():
    resource.setrlimit(resource.RLIMIT_CPU, (10, 10))
    resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
    resource.setrlimit(resource.RLIMIT_FSIZE, (1024 * 1024, 1024 * 1024))
    request = json.loads(sys.stdin.buffer.read(1024 * 1024 + 1))
    if request == {"operation": "preflight"}:
        result = {"python": list(sys.version_info[:3]), "driver": "trace-chat-game-v1"}
    else:
        module = load_game()
        seed = request["seed"]
        if type(seed) is not int or not 0 <= seed < 2**31:
            raise ValueError("seed must be a bounded nonnegative integer")
        if request["operation"] == "reference":
            actions = module.reference_actions(seed)
            if not isinstance(actions, list) or not 1 <= len(actions) <= 64:
                raise ValueError("reference_actions must return a bounded action list")
            result = {"actions": actions}
        elif request["operation"] == "replay":
            actions = request["actions"]
            if not isinstance(actions, list) or len(actions) > 64:
                raise ValueError("action history must be a bounded list")
            result = {"snapshots": execute(module, seed, actions)}
        else:
            raise ValueError("unsupported TRACE driver operation")
    print(json.dumps(result, ensure_ascii=False, allow_nan=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"error": {"type": type(error).__name__, "message": str(error)}}))
