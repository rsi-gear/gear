"""Multi-frontier A1 evaluation parity: two subjects reuse one TaskSelection."""
from gear_algorithm.author import algorithm


@algorithm
async def sample(ctx):
    selection = await ctx.tasks.sample(ctx.data.search_tasks, count=2, seed=7)
    candidate = ctx.data.candidate
    settled = await ctx.parallel([
        ctx.evaluate(ctx.initial_agent, tasks=selection),
        ctx.evaluate(candidate, tasks=selection),
    ])
    values = [item.value for item in settled if item.ok]
    winner = ctx.select(values, metric="pass_rate", require_improvement=True).agent
    return ctx.result(selected=winner, outputs={"selection": selection, "evaluations": settled})
