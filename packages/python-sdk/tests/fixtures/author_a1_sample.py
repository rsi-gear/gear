"""Pure v2 author fixture for Python/TypeScript replay parity."""
from gear_algorithm.author import algorithm


TASK_VIEW = {"kind": "artifact", "digest": "b" * 64, "size": 10,
             "mediaType": "application/json", "schemaId": "task.view.v1"}
CONFIG_SCHEMA = {"type": "object", "properties": {"mode": {"type": "string"}},
                 "required": ["mode"], "additionalProperties": False}


@algorithm(config_schema=CONFIG_SCHEMA)
async def sample(ctx):
    role = await ctx.role("analyst", {"goal": ctx.config.mode})
    selection = await ctx.tasks.sample(TASK_VIEW, count=2, seed=7)
    return ctx.result(selected=ctx.initial_agent,
                      outputs={"role": role.output, "taskViewRef": selection.task_view_ref})
