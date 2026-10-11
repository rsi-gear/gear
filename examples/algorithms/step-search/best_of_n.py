from gear_algorithm.author import algorithm


@algorithm(id="best-of-n")
def search(ctx):
    state, svc = ctx.state, ctx.services
    if state is None:
        return ctx.run({"phase": "propose"}, tasks=svc.sample(ctx.task_source, 2, 42))
    if state["phase"] == "propose":
        tasks = ctx.results["tasks"]
        if not tasks.ok:
            return ctx.finish(outputs={"failure": tasks.error})
        return ctx.run({"phase": "evaluate", "tasks": tasks.value},
                       proposals=svc.propose(ctx.initial_candidate, count=ctx.config["n"]))
    if state["phase"] == "evaluate":
        proposals = ctx.results["proposals"]
        if not proposals.ok:
            return ctx.finish(outputs={"failure": proposals.error})
        candidates = proposals.value["candidates"]
        if not candidates:
            return ctx.finish(outputs={"proposal_failures": proposals.value["failures"]})
        return ctx.run({"phase": "select"}, **{
            f"candidate_{i}": svc.evaluate(candidate, state["tasks"])
            for i, candidate in enumerate(candidates)
        })
    measured = [result.value for result in ctx.results.values()
                if result.ok and result.value["comparable"]]
    if not measured:
        return ctx.finish(outputs={"status": "no_valid_evaluation"})
    # Acceptance belongs to this algorithm. A valid zero remains a measurement.
    best = max(measured, key=lambda evaluation: evaluation["metrics"]["pass_rate"])
    return ctx.finish(selected=best["subject"], outputs={"evaluation": best})
