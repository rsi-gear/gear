"""Default native composition; scripts can instead compose any four stages."""
from gear_training.recipes.registry import is_sft
from gear_training.online_rl import build_loop as build_online_loop
from gear_training.offline_sft import build_loop as build_sft_loop


def build_loop(config, runtime):
    return (build_sft_loop if is_sft(runtime.request) else build_online_loop)(config, runtime)
