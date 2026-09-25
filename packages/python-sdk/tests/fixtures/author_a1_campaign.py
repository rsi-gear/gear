"""Three-wave v2 Campaign fixture; worker is restarted for every replay."""
from gear_algorithm.author import algorithm


@algorithm(config_schema={"type": "object", "required": ["goal"],
                          "properties": {"goal": {"type": "string"}},
                          "additionalProperties": False})
async def sample(ctx):
    role = await ctx.role("analyst", {"goal": ctx.config.goal})
    selection = await ctx.tasks.sample(ctx.data.task_view_ref, count=2, seed=7)
    archive = await ctx.checkpoint("proof", {"role": role, "selection": selection})
    return ctx.result(selected=ctx.initial_agent,
                      outputs={"archive": archive, "selectedTaskIds": selection.selected_task_ids})
