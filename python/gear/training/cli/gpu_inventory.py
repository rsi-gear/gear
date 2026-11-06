"""Internal subprocess entrypoint for the selected training backend."""

import json

from gear.training.backends.slime.gpu_visibility import cuda_inventory


def main():
    print(json.dumps(cuda_inventory()))


if __name__ == "__main__":
    main()
