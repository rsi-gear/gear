"""Real Python worker fixture for the A0 Campaign replay bridge."""
from gear_algorithm.author import algorithm, workflow


@workflow(version="v1")
async def candidate(ctx, label, extra):
    role = await ctx.role("analyst", {"label": label})
    edit = await ctx.edit({"label": label, "role": role})
    if extra:
        await ctx.operation("fixture.extra", {"label": label})
    tasks = await ctx.parallel([
        ctx.rollout({"label": label, "task": index, "edit": edit})
        for index in range(10)
    ])
    measured = await ctx.measure({"label": label, "tasks": tasks})
    return measured


@algorithm
async def sample(ctx):
    branches = await ctx.parallel([candidate("left", False), candidate("right", True)])
    archive = await ctx.checkpoint("population", {"branches": branches})
    return ctx.result(outputs={"population": archive})
