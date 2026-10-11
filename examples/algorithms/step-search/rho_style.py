"""Content-selected coreset and author-owned acceptance; not full RHO/RRSI."""
from gear_algorithm import algorithm


@algorithm(id="rho-style")
def search(ctx):
    state, svc = ctx.state, ctx.services
    if state is None:
        return ctx.run({"phase": "select"}, content=svc.tasks(ctx.task_source))
    if state["phase"] == "select":
        content = ctx.results["content"]
        if not content.ok:
            return ctx.finish(outputs={"failure": content.error})
        # Replace this pure Python ranking with a difficulty/coverage model.
        selected = sorted(content.value, key=lambda task: len(task["prompt"]), reverse=True)[:2]
        return ctx.run({"phase": "propose"}, tasks=svc.select([task["id"] for task in selected]))
    if state["phase"] == "propose":
        tasks = ctx.results["tasks"]
        if not tasks.ok:
            return ctx.finish(outputs={"failure": tasks.error})
        return ctx.run({"phase": "compare", "tasks": tasks.value},
                       proposals=svc.propose(ctx.initial_candidate, count=2))
    if state["phase"] == "compare":
        proposals = ctx.results["proposals"]
        if not proposals.ok:
            return ctx.finish(outputs={"failure": proposals.error})
        candidates = [ctx.initial_candidate, *proposals.value["candidates"]]
        return ctx.run({"phase": "accept"}, **{
            f"candidate_{i}": svc.evaluate(candidate, state["tasks"])
            for i, candidate in enumerate(candidates)
        })
    valid = [result.value for result in ctx.results.values() if result.ok and result.value["comparable"]]
    if not valid:
        return ctx.finish(outputs={"status": "no_valid_evaluation"})
    baseline = ctx.results["candidate_0"]
    best = max(valid, key=lambda measured: measured["metrics"]["pass_rate"])
    # A scientific policy belongs here, including minimum improvement and ties.
    if baseline.ok and baseline.value["comparable"]:
        gain = best["metrics"]["pass_rate"] - baseline.value["metrics"]["pass_rate"]
        if gain < ctx.config.get("minimum_gain", 0.1):
            best = baseline.value
    return ctx.finish(selected=best["subject"], outputs={"evaluation": best})
