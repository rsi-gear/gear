# Parent policy example

This example registers a third parent sampler through the public search API. It runs a synthetic search, interrupts after the parent decision is stored, resumes from a journal checkpoint, and verifies replay without new evaluations.

Install a built `rsi-gear` tarball in this directory and run:

```sh
npm install /path/to/rsi-gear-0.1.0.tgz
npm start
```

From the Gear repository, `npm run test:search:package` builds and installs the package in an isolated consumer project and also typechecks these JavaScript modules.

Start with `uniform-parent.mjs` to change the policy; `demo.mjs` provides the runner and recovery checks. No model credentials, Hitch, or Docker are required. See the [authoring guide](../../docs/search-algorithm-authoring.zh-CN.md) for the contract and configuration rules.
