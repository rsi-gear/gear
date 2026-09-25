"""One physical failure, retained as an A1 tracked terminal outcome."""
from gear_algorithm.author import algorithm


@algorithm(config_schema={"type": "object", "required": ["goal"],
                          "properties": {"goal": {"type": "string"}},
                          "additionalProperties": False})
async def sample(ctx):
    tracked = await ctx._tracked_operation(
        "execution.rollout", {"taskId": "task-0"},
        binding_set_ref=ctx.initial_agent.binding_set_ref, limits={})
    return ctx.result(selected=ctx.initial_agent, outputs={"tracked": tracked})
