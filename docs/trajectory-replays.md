# Trajectory replay notes

These two selected AutomationBench Marketing tasks compare GPT 5.6 Luna at max reasoning effort with the GEAR-optimized DSH harness (`a0740800`) against GPT 6 Astra at max effort in native Codex CLI 0.154.0. Both runs of each case use the same task digest and verifier identity.

The animations replay selected tool calls, results, and public assistant messages in their original order within each lane. Excerpts are condensed and timing is edited; the animations do not compare execution speed. No private reasoning is included.

| Case | Luna outcome | Astra outcome | Scored checks |
| --- | --- | --- | --- |
| Landing page alerts | Reads the VP Marketing update, applies the 3% conversion cutoff, and includes Careers in the posted alert. | Uses a 2% cutoff and omits Careers from the posted alert. | 5/5 vs. 4/5 |
| Weekly lead scoring | Sends the report to Sales and reads back the sent message. | Creates and reads back a provisional draft without sending it. | 11/11 vs. 0/11 |

For lead scoring, neither run retrieved the official process document. Luna used the prior report and spreadsheet notes; Astra explicitly kept its report provisional because the current criteria could not be verified. Every one of this task's 11 scored checks requires a sent message, so the draft receives zero even though Astra completed substantial preparation. The displayed category totals are the contents of the respective report and draft, not a count of verifier assertions. Two recipient-exclusion checks are outside the partial score. The landing-page task has four exclusion checks outside its five scored checks.

## Cost basis

Costs use the recorded task-token usage and standard API rates as of September 18, 2026. They are API-equivalent estimates, not Codex subscription charges or actual invoices. They exclude harness optimization, previous attempts, title generation, and infrastructure. The lead-scoring Codex usage is aggregated across the run, so its estimate applies standard rates without a separately verified per-request long-context adjustment.

| Case | Luna estimate | Astra estimate | Luna reduction |
| --- | ---: | ---: | ---: |
| Landing page alerts | $0.03695304 | $0.556566 | 93.4% |
| Weekly lead scoring | $0.07163208 | $1.415164 | 94.9% |

Rates per million tokens (uncached input / cached input / output): [Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna), $0.20 / $0.02 / $1.20; [Astra](https://developers.openai.com/api/docs/models/gpt-6-astra), $10 / $1 / $50. Output includes reasoning tokens and is counted once. DSH's input counter excludes cached input; Codex's input counter includes it. Neither selected run pair has cache-write tokens.

[Replay evidence](guide/assets/marketing-trajectory-replays.json) records the run IDs, source hashes, task and verifier identities, selected event sequence numbers, token counts, and scoring components.

These are illustrative cases, not the full benchmark result. Across the 100-task suite, Luna's task pass rate is 53% and Astra's is 57%. Both the model and harness differ, so the comparison does not isolate the effect of GEAR alone. See [benchmark results](guide/en/results.md).
