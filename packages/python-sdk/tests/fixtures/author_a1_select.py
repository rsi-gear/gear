"""Pure author selection with frozen host metric semantics."""
from gear_algorithm.author import algorithm


@algorithm
async def sample(ctx):
    winner = ctx.select(ctx.data.evaluations, metric="score", require_improvement=True).agent
    return ctx.result(selected=winner)
