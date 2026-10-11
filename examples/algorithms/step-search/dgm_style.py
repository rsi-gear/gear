"""Reproduce from every admitted archive member, including nonwinners; not full DGM."""
from gear_algorithm import Archive, algorithm


@algorithm(id="dgm-style")
def search(ctx):
    state, svc = ctx.state, ctx.services
    if state is None:
        return ctx.run({"phase": "propose", "archive": [ctx.initial_candidate], "round": 0},
                       tasks=svc.sample(ctx.task_source, 2, 42))
    if state["phase"] == "propose":
        if "tasks" not in state:
            tasks = ctx.results["tasks"]
            if not tasks.ok:
                return ctx.finish(outputs={"failure": tasks.error})
            state = {**state, "tasks": tasks.value}
        # Round robin deliberately visits nonwinners too.
        parent = state["archive"][state["round"] % len(state["archive"])]
        return ctx.run({**state, "phase": "measure"}, children=svc.propose(parent, count=2))
    if state["phase"] == "measure":
        children = ctx.results["children"]
        if not children.ok or not children.value["candidates"]:
            return ctx.finish(outputs={"archive": state["archive"]})
        return ctx.run({**state, "phase": "admit"}, **{
            f"child_{i}": svc.evaluate(candidate, state["tasks"])
            for i, candidate in enumerate(children.value["candidates"])
        })
    archive, best = Archive(state["archive"]), state.get("best")
    for result in ctx.results.values():
        if not result.ok or not result.value["comparable"]:
            continue
        measured = result.value
        archive.add(measured["subject"])  # Admission does not require beating the winner.
        if best is None or measured["metrics"]["pass_rate"] > best["metrics"]["pass_rate"]:
            best = measured
    if state["round"] + 1 >= ctx.config.get("rounds", 3):
        return ctx.finish(selected=best["subject"] if best else None, outputs={"archive": archive})
    parent = archive[(state["round"] + 1) % len(archive)]
    return ctx.run({**state, "phase": "measure", "archive": archive, "best": best,
                    "round": state["round"] + 1}, children=svc.propose(parent, count=2))
