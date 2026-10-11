# Python algorithm + Python provider (experimental)

This project is the output of `algorithm init DIRECTORY python`. It uses a named Gear operation and a durable local echo provider. Install the standalone `gear-algorithm` wheel into the interpreter named in `gear.algorithm.json`, then run the Gear host's experimental CLI:

```sh
node PATH_TO_GEAR/lib/algorithm/cli.js check gear.algorithm.json
node PATH_TO_GEAR/lib/algorithm/cli.js run gear.algorithm.json
node PATH_TO_GEAR/lib/algorithm/cli.js resume gear.algorithm.json
```

`run` creates the Campaign journal under `.gear/toy`; `resume` reads the committed result. This example does not use a model or training backend.
