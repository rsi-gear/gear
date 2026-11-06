"""Internal subprocess entrypoint for the selected training backend."""

import os

from gear.training.backends.slime.driver import run


def main():
    run(os.environ["GEAR_TRAINING_JOB"])


if __name__ == "__main__":
    main()
