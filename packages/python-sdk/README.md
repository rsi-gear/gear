# gear-algorithm

A dependency-light Python author API for Gear. Requires Python 3.11+; install the Node `rsi-gear` host separately. No training libraries are installed.

This branch is not published. Build both artifacts from the same checkout and follow the [local-artifact quickstart](../../docs/algorithm-author-cli.zh-CN.md). To build this wheel from the repository root:

```sh
python3.11 -m pip wheel --no-build-isolation --no-deps ./packages/python-sdk --wheel-dir /tmp/gear-sdk-artifacts
```

Install that wheel into the configured interpreter and the matching npm tarball into the author project before running `gear algorithm init ./my-search python`.

Set `algorithm.interpreter` in `gear.algorithm.json` to the interpreter containing this package, then use `gear algorithm check`, `run`, and `resume`.

```python
from gear_algorithm import algorithm

@algorithm(id="baseline")
def search(ctx):
    if ctx.state is None:
        return ctx.run({"phase": "evaluate"}, tasks=ctx.services.sample(ctx.task_source, 1))
    if ctx.state["phase"] == "evaluate":
        tasks = ctx.results["tasks"]
        if not tasks.ok:
            return ctx.finish(outputs={"failure": tasks.error})
        return ctx.run({"phase": "finish"}, measured=ctx.services.evaluate(ctx.initial_candidate, tasks.value))
    measured = ctx.results["measured"]
    if not measured.ok or not measured.value["comparable"]:
        return ctx.finish(outputs={"status": "no_valid_evaluation"})
    return ctx.finish(selected=measured.value["subject"], outputs={"evaluation": measured.value})
```

`ctx.run(state, **requests)` atomically commits explicit JSON state and operation intents before effects start. Only this state is resumed. Pure computation in an uncommitted step may run again; module globals, object caches, arbitrary Python heaps and coroutines are not persistent. Normal Python libraries are allowed.

Services provide task sampling, real task content, author-selected tasks, candidate proposals, evaluation, named model roles and additional host-granted calls. Results preserve failures separately from incomplete/invalid evaluations and valid zero scores. The author owns acceptance, archive admission and termination. `Archive` is a JSON-compatible list of reproduction candidates; Campaign remains the factual history.

The default recorded host is an offline teaching fixture. Physical execution uses the same capability API with Git, authorized tasks, DSH roles/editors and trusted Hitch measurement. Unknown external submissions are inspected rather than blindly repeated. Interrupted model sessions may require reconciliation; arbitrary model-session continuation is not promised.

See [authoring](../../docs/algorithm-authoring.zh-CN.md), [CLI](../../docs/algorithm-author-cli.zh-CN.md), and [three Python control structures](../../examples/algorithms/step-search/README.md). Existing scientific recipes and low-level provider contracts remain for internal migration and regression coverage; the explicit-state API is the default for new authors.

Build a wheel with `python3.11 -m pip wheel --no-build-isolation --no-deps .`; `npm run test:algorithm:package` installs the wheel and npm tarball into an external project and exercises the default CLI.
