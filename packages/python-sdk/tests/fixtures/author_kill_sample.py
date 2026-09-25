"""Metered two-branch Python author graph for controller SIGKILL recovery."""
from gear_algorithm.author import algorithm, workflow


@workflow(version="v1")
async def candidate(ctx, label):
    role = await ctx.role("analyst", {"label": label})
    edit = await ctx.edit({"label": label, "role": role})
    tasks = await ctx.parallel([
        ctx.operation("author.rollout", {"label": label, "task": index, "edit": edit},
                      limits={"calls": 1})
        for index in range(10)
    ])
    return await ctx.measure({"label": label, "tasks": tasks})


@algorithm
async def sample(ctx):
    branches = await ctx.parallel([candidate("left"), candidate("right")])
    archive = await ctx.checkpoint("population", {"branches": branches})
    return ctx.result(outputs={"population": archive})
