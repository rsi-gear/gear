"""Three original proposal ordinals through editor and binding derivation."""
from gear_algorithm.author import algorithm


@algorithm
async def sample(ctx):
    proposals = await ctx.propose(ctx.initial_agent, feedback=ctx.data.feedback,
                                  role="optimizer", count=3)
    return ctx.result(outputs={"proposals": proposals})
