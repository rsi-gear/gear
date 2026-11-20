# Third-party materials

This probe uses Tau2-Bench v1.0.1 at commit
`fc0055dc4e0a316c3f83133267fbd6faaa770992` from
[sierra-research/tau2-bench](https://github.com/sierra-research/tau2-bench/tree/fc0055dc4e0a316c3f83133267fbd6faaa770992).
The archived model inputs contain its retail policy and tool descriptions.
The original [MIT license](TAU2-LICENSE.txt) is included without modification.
No upstream benchmark database, benchmark task set, model weights, or
implementation code is copied into this directory.

The small database contains authored fictional Gear test customers. The fixed
source task came from the previous real generator probe, whose diagnosis used
an explicit source-failure fixture. In this probe the solver model responses,
tool execution and resulting verdicts are actual observations. The failed
solver uses an explicitly premature stopping rule as a diagnostic control;
this is not an estimate of natural model failures or improvement benefit.

The recipe follows the trajectory-first generation idea in
[SENTINEL](https://arxiv.org/html/2606.12908v1). It does not copy the paper's
prompts or claim a complete reproduction. Native thread and turn identifiers
are omitted from the exported receipts.
