"""Feedback-guided improvement; a teaching control structure, not full GEPA."""
from gear_algorithm import algorithm


@algorithm(id="gepa-style")
def search(ctx):
    state, svc = ctx.state, ctx.services
    if state is None:
        return ctx.run({"phase": "baseline", "round": 0}, tasks=svc.sample(ctx.task_source, 2, 42))
    if state["phase"] == "baseline":
        tasks = ctx.results["tasks"]
        if not tasks.ok:
            return ctx.finish(outputs={"failure": tasks.error})
        return ctx.run({**state, "phase": "improve", "tasks": tasks.value},
                       measured=svc.evaluate(ctx.initial_candidate, tasks.value))
    if state["phase"] == "improve":
        measured = ctx.results["measured"]
        if not measured.ok or not measured.value["comparable"]:
            return ctx.finish(outputs={"status": "no_valid_evaluation"})
        best = measured.value
        if "best" in state and state["best"]["metrics"]["pass_rate"] >= best["metrics"]["pass_rate"]:
            best = state["best"]
        if state["round"] >= ctx.config.get("rounds", 2):
            return ctx.finish(selected=best["subject"], outputs={"evaluation": best})
        return ctx.run({**state, "phase": "measure", "best": best},
                       proposal=svc.propose(best["subject"], feedback=best))
    proposed = ctx.results["proposal"]
    if not proposed.ok or not proposed.value["candidates"]:
        return ctx.finish(selected=state["best"]["subject"], outputs={"status": "no_proposal"})
    return ctx.run({**state, "phase": "improve", "round": state["round"] + 1},
                   measured=svc.evaluate(proposed.value["candidates"][0], state["tasks"]))
