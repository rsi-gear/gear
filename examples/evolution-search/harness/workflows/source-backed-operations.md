# Source-backed operations

Turn the requested workflow into a source-backed action ledger before writing.
Use this procedure for policy-driven operations, batch processing, and reports
derived from business records. A simple action with fully specified inputs
does not need the full procedure.

Keep the source map and ledger in working state; do not create external planning
documents unless requested. Reuse evidence already read. Batch independent reads
and writes when supported, while preserving dependencies and the tool budget.

## 1. Resolve the inputs and destinations

Identify the source records, applicable procedure, and each output destination.
Record actual IDs and their roles. Use supplied IDs directly once the endpoint
is known; read metadata to map worksheet IDs to titles and inspect columns.
Endpoint discovery finds operations; app-content reads establish business facts.

If the task refers to additional rules, current criteria, batch requirements,
or shared process notes whose contents are not supplied, record governing
guidance as a lookup dependency even when no document is named. Supplied
recipients and a populated processing queue do not resolve that dependency:
the requirements may govern eligibility, routing, and content as well as how
actions are grouped.

Read the **resolve workflow sources** subprocedure at the absolute path supplied
in the harness workflow guidance before the first dependent mutation whenever
that guidance, a referenced procedure or prior format, or an existing
destination remains unresolved, including when only a partial update is read.
It separates the processing query from the guidance query and provides the
source-completeness test. Reuse resolved evidence and the procedure once read;
fully specified inputs need no additional lookup.

Carry its resolved sources into the contract below. Keep remaining dependencies
explicit and complete independent authorized work without inventing missing
rules, records, recipients, approvals, or duplicate-check results.

## 2. Compile the workflow contract

Before the first mutation, write a compact contract from the user request and
the retrieved sources. Attach a source reference to rules that affect action.
Include only relevant requirements:

| Contract part | Capture |
| --- | --- |
| Scope | Dataset, requested period/as-of date, statuses, eligibility boundaries |
| Exceptions | Holds, exclusions, overrides, duplicates and already-processed records |
| Actions | Each required branch and its dependencies, including notifications, audit records, and follow-up status changes |
| Destinations | Resource IDs, owners/recipients, and which records each receives |
| Content | Required fields, exact codes, subject/body placement, template, source values, totals/counts and units |
| Completion | Observable final state or receipt for each required action |

Reconcile instructions by authority, applicability, effective date, and explicit
supersession. A newer message does not automatically override the controlling
procedure or user constraints. Keep compatible requirements from earlier
instructions; replace only what the applicable update changes. Treat outside
suggestions as suggestions, not authorization to expand scope or distribution.

## 3. Build the record/action ledger

Evaluate the complete relevant source set once. For each relevant record retain:

`source key | original values | eligibility + rule/exception | required actions | destination/owner | pending or receipt`

Use actual IDs, contact details and explicit duplicate relationships to join
records. Similar names alone do not establish identity; unusual names or
prefixes alone do not establish exclusion. Normalize labels for comparison
where appropriate, while retaining the original source text for output.

Apply explicit holds and exclusions before generic eligibility unless the
controlling instructions provide an exception. Separate "no action" from
"requires a special notice or escalation": the procedure may prescribe
different outcomes. Keep internal selection reasons out of delivery drafts
unless that destination requires them.

Compute counts, aggregates and per-record calculations from this ledger's
selected set, rather than a second hand-picked list. Retain the contributing
keys and units. Keep derived results separate from raw source values; apply
requested formatting to derived results without silently rounding or
paraphrasing source values. Handle blank, zero and invalid values explicitly.

## 4. Reconcile each planned delivery before writing

Create each payload as a projection of the ledger for its actual destination.
Before sending or mutating, check in both directions:

1. Every eligible record has every required action, including separate workflow
   branches and any specifically required audit or confirmation.
2. Every planned action and reported record has a source-backed reason and
   belongs in that destination's scope.
3. Each owner/recipient matches the source key. Required fields and tracking
   references appear in the actual payload at the specified location. A code
   in the final chat answer does not populate a log cell or email body.
4. Counts and amounts reconcile with the same projected records. Reporting
   scope applies to explanatory sections too: an excluded-record appendix is
   itself a disclosure. Include exclusion notices only when required/permitted
   by controlling instructions, and only in the prescribed destination.
5. The destination schema can store the required fields. Resolve a schema gap
   before writing; use an authorized schema change when appropriate rather
   than silently dropping a required field.

Construct structured payloads programmatically from the reviewed ledger. For
CLI requests with nested JSON, multiline/quoted text, or encoded fields, read
**structured CLI requests** and use its request helper at the paths supplied in
the harness guidance. It serializes nested objects and passes encoder output
directly into the existing adapter without copying long encoded strings.
Native tools with structured arguments need no wrapper.

## 5. Execute and close the ledger

Execute authorized actions in dependency order, recording returned IDs and
results against ledger entries. Mark downstream status only after its
prerequisite succeeds. After an ambiguous response, check existing state before
retrying a write that could duplicate a send or append.

Verify the contract at the actual destination using returned fields or a
focused readback: record identity, stored values, recipients, required content,
and completed status. A successful API response proves only what it returns.
A created document's metadata does not establish its content, and a route label
in a sheet does not establish that the required notification was sent.

Compare required actions with confirmed receipts, repair supported mismatches,
and leave any unresolved dependency explicit. Stop when the ledger reconciles;
do not repeat broad verification or send cosmetic correction messages without
a material requirement. Report completed work and specific remaining blockers
within the task's reporting scope. Do not label requests, plans, or unchecked
assumptions as completed actions.
