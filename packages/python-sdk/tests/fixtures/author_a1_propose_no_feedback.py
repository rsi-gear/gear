"""Proposal without a feedback measurement, for random or prior-only search."""
from gear_algorithm.author import algorithm


@algorithm
async def sample(ctx):
    proposals = await ctx.propose(ctx.initial_agent, role="optimizer", count=1)
    return ctx.result(outputs={"proposals": proposals})
