"""Compatibility launcher. Prefer python -m gear_training run SPEC --config CONFIG."""
from gear_training.dev_launcher import main

if __name__ == "__main__":
    raise SystemExit(main())
