"""GRPO entrypoint and aliases for the shared native online-RL components."""
from .online_rl import FrozenTaskSource, HitchRolloutExecutor, GRPODatasetBuilder, PolicyDatasetBuilder, SlimeModelUpdater, build_loop


def main():
    from .dev_launcher import main as launch
    return launch()


if __name__ == "__main__": raise SystemExit(main())
