# Third-party materials

This integration run uses Tau2-Bench v1.0.1 at commit
`fc0055dc4e0a316c3f83133267fbd6faaa770992` from
[sierra-research/tau2-bench](https://github.com/sierra-research/tau2-bench/tree/fc0055dc4e0a316c3f83133267fbd6faaa770992).
The archived model inputs include its retail policy and tool descriptions; tool
responses and verification output were produced by that installed implementation.
The upstream [MIT license](TAU2-LICENSE.txt) is included without modification.
No upstream benchmark database, task set, model weights or implementation code
is included in this directory.

The small training database and source failure fixture were authored for Gear's
integration tests. They do not contain benchmark test customers or real customer
information. Source failures and semantic model judgments are labeled separately
from actual tool execution in the report.

The caller follows the trajectory-first generation idea in
[SENTINEL](https://arxiv.org/html/2606.12908v1); it does not copy the paper's prompts
or claim an upstream implementation or full reproduction.
