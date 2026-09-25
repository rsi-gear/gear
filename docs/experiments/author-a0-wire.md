# Author A0 replay wire (version 1)

This is the frozen narrow PoC protocol shared by the TypeScript and Python replay drivers. It carries no provider effects. The sole mutable campaign head remains the existing Campaign journal.

```ts
type Request = {
  version: 'gear.author.replay.v1';
  input: { initialAgent: JsonValue; data: JsonValue; config: JsonValue };
  history: Array<{
    address: string; kind: string; definitionVersion: string; inputDigest: string;
    outcome: OperationOutcome; // existing Gear kernel terminal outcome
  }>;
};
type Reply =
  | { status: 'waiting'; frontier: Array<{
      address: string; kind: string; definitionVersion: string; input: JsonValue;
      bindingSetRef?: BindingSetRef; limits?: Record<string, number>;
      startsBudgetClock?: boolean;
    }> }
  | { status: 'completed'; result: JsonValue };
```

`OperationOutcome` is the existing kernel union: `result(value)`, `error(code,message,retryable?)`, `no-result(reason?)`, `inconclusive(reason)`, or `cancelled(reason?)`. Infrastructure `unknown`, `running`, and `intent` never become history entries or author values. The kernel waits for every member of a committed frontier to reach a terminal outcome before invoking reduce. Parallel collect returns outcomes in input order as `{ok:true,value}` or `{ok:false,error:{kind,code?,message?,reason?}}`.

The root scope is `r`. Every ManagedCall reserves the next scope-local ordinal `sN` when constructed, including `parallel`; children constructed before a parallel container leave deterministic gaps in the parent ordinals. The container reparents each child on consumption. Parallel child I has scope `<parent>/sN/pI`; its first call is `<parent>/sN/pI/s0`. A custom `workflow(fn)` call similarly consumes `sN` and executes in that child scope. SDK internal stages add fixed named path components and stable candidate/task ordinals. The root definition version is `algorithm.v1`; a custom workflow appends its declared `name@version` to the inherited version chain, and parallel inherits that chain. No address depends on completion order, time or random values. A local operation key is a reversible encoding of the path, subject to the kernel's 128-character limit; excess depth is rejected before intent submission.

Replay validates every historical address against kind, definition version, and the canonical author-intent digest. It rejects unvisited history, early return, changed input and duplicate consumption before a new intent is submitted. Unconsumed ManagedCalls are an error on normal return; a waiting branch may hold calls that it will consume later. A current frontier is an ordered array of unique atomic addresses. Its intent and `pendingGroup` commit together. On reduce, terminal outcomes are appended to an immutable CAS history page and the new `historyHeadRef` is committed in `nextState` with the next frontier. No independent workflow head exists. `author.checkpoint` versions are identified by their logical address even if the name repeats.

`inputDigest` is SHA-256 of Gear `canonicalJson` over `{input,bindingSetRef?,limits?,startsBudgetClock?}` as emitted by the worker, before the host freezes `author.observe` values. It excludes address and kind, which are checked separately. Gear `canonicalJson` uses: UTF-8 JSON without spaces; object keys sorted by UTF-8 byte order; arrays ordered; scalar formatting follows JavaScript `JSON.stringify`; unsafe keys, unsafe integral numbers, non-finite numbers and unpaired surrogates are rejected. The shared `tests/fixtures/author-wire-vectors.json` checks TS/Python canonical bytes and digests for safe integers, nonintegral floats, exponent thresholds, Unicode key order and nested intent descriptors. Unsafe integral numbers remain rejected.

Each encoded request/reply is limited to 1 MiB and each raw CAS history page to 256 KiB. A0 sends bounded terminal history in one request; oversized history fails closed until cursor-based worker paging is added. Both drivers must reject out-of-version messages. The host, not the worker, freezes budget/clock/random seed/ID values in `author.observe` inputs; its pure provider returns that exact value and does not meter or start the budget clock.

## A0 implementation scope

`maxFrontierWaves` is an explicit run option; 200 is only a probe value, not a selected product default. The A0 adapter uses the existing AlgorithmRuntime and CampaignStore as its sole writer. It sends all bounded history in one worker request and fails closed above 1 MiB; cursor paging and large output chunking are not implemented. A0 checkpoint accepts only `author.archive.v1` JSON/typed refs at most 256 KiB per value; terminal output publication verifies the reachable built-in ref graph. Custom output schemas, import, and full A1 RunSpec/CLI author entry are later work.

The TS process port freezes the author project, compiled Gear host tree, Node executable/version identity, and the exact TypeScript compiler entrypoint/package metadata used for source diagnostics. The Python port shares the Node host identity. It accepts local imports only within the sealed project or Gear host root, rejects bare package imports, and runs diagnostics for known unsafe time, random, IO, bare concurrency and mutable top-level capture patterns. It is not a sandbox for arbitrary JS packages or hidden side effects. The Python port requires Python >=3.11, an explicit SDK path and a `.py` module inside the frozen project; it seals project/SDK bytes, interpreter bytes/version, package versions and worker-loaded module file digests. Both ports recheck identity before every replay. The controller process may be killed; replay reconstructs pure control flow from the committed history and pending group.
