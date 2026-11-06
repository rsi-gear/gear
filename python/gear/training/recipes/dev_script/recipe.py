"""Default native composition; scripts can instead compose any four stages."""

from gear.training.pipelines.offline_sft import build_loop as build_sft_loop
from gear.training.pipelines.online_rl import build_loop as build_online_loop
from gear.training.recipes.registry import is_sft


def build_loop(config, runtime):
    return (build_sft_loop if is_sft(runtime.request) else build_online_loop)(config, runtime)
