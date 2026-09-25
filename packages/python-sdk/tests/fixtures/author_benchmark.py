"""Python half of the frozen A0 fake-provider benchmark graph.

The TypeScript comparator uses the same inputs and terminal fake outcomes.
No model, GPU, or real external provider is invoked here.
"""
from gear_algorithm.author import algorithm, workflow


@workflow(version="v1")
async def candidate(ctx, round_index, candidate_index):
    role = await ctx.role("bench-role", {"round": round_index, "candidate": candidate_index})
    edit = await ctx.edit({"round": round_index, "candidate": candidate_index, "role": role})
    rollouts = await ctx.parallel([
        ctx.rollout({"round": round_index, "candidate": candidate_index,
                     "task": task, "revision": edit.revision})
        for task in range(10)
    ])
    return await ctx.measure({"round": round_index, "candidate": candidate_index,
                              "rollouts": rollouts})


@algorithm
async def composite(ctx):
    rounds = []
    for round_index in range(3):
        measured = await ctx.parallel([candidate(round_index, index) for index in range(4)])
        rounds.append(measured)
    return ctx.result(outputs={"rounds": rounds})


@algorithm
async def rho_shaped(ctx):
    initial = await ctx.measure({"initial": True})
    ranks = []
    for round_index in range(3):
        measured = await ctx.parallel([candidate(round_index, index) for index in range(4)])
        rank = await ctx.operation("author.rank", {"round": round_index, "measurements": measured})
        await ctx.checkpoint("population", {"round": round_index, "rank": rank})
        ranks.append(rank)
    return ctx.result(outputs={"initial": initial, "ranks": ranks})
