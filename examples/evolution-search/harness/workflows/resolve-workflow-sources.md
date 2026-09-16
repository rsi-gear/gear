# Resolve workflow sources

Produce a usable source map before selecting records or writing actions that
depend on missing guidance. Reuse sources already read. This procedure is
complete when the needed facts and destinations are resolved; fully specified
actions and ordinary repository work do not need it.

## 1. Name the missing dependency

Keep a compact record in working state, not an external planning document:

`need | source ref and role | fact established | unresolved question | next read`

Separate these roles when the task requires them:

- **Records:** actual resource ID, relevant scope, columns, and any referenced
  eligibility or duplicate-check data.
- **Standing procedure:** selection rules, ordinary action branches, recipients,
  reporting requirements, and what constitutes completion.
- **Amendment:** which parts of that procedure an applicable update changes.
- **Prior example:** the actual earlier artifact when a prior format is requested.
- **Destination:** the existing resource ID, schema, or recipient mapping.

A single source may resolve several roles. The user request may already supply
a complete rule or destination; do not invent another prerequisite. A subject,
search snippet, or endpoint description alone does not resolve a content need.

### Separate processing scope from guidance scope

When additional instructions need lookup, prepare two query scopes before
selecting records for action:

| Purpose | Query scope | Evidence retained |
| --- | --- | --- |
| Processing | The requested queue, statuses, labels, and record period | Candidate record IDs and original values |
| Guidance | The workflow topic and any supplied source reference; apply only filters justified for finding its instructions | Full applicable source content and the rules it establishes |

Do not inherit unread-only, inbox-only, active-record, or processing-date filters
into the guidance query. Governing instructions can be already read, outside
the queue, or older than the records they govern. Keep the processing scope
unchanged when broadening guidance discovery; an extra search hit is not itself
a record to act on.

For unnamed requirements, use the available app-content search with the workflow
topic, then read relevant instructions in full. Use the bounded fallback ladder
below if that adds no relevant evidence. The queue listing and endpoint search
do not count as this lookup. Independent record and guidance reads may run in
parallel. Close the guidance dependency with the source reference and extracted
rules, or record the attempted lookup and what remains unknown. If the task only
suggests optional notes, a bounded search finds none, and the supplied rules
suffice, continue using those rules without inventing additional requirements.

## 2. Choose the next read from the unresolved question

Discover an endpoint schema once, then use its app-content search/read operation.
Record which operation actually ran and whether it returned content, metadata,
an empty result, or an error. Endpoint search cannot establish that a policy or
queue is absent. Use returned URLs and parameter schemas, substituting known
IDs in path parameters; do not guess endpoint names.

| Evidence so far | Next read |
| --- | --- |
| An ID or direct source link is supplied | Read that resource. For a worksheet, read workbook metadata to map its ID to the actual tab and columns. |
| A message points to another channel, thread, document, or prior report | Follow that specific reference and read the relevant full content. |
| A topic search is empty or unrelated | Remove extra words and restrictive date, unread, sender, or exact-phrase filters not required by the task. Try a distinctive topic term. |
| A named channel search still misses the source | Resolve the channel ID and read bounded relevant history, including referenced threads. |
| Chat supplies only a short update or no procedure | Search an available mailbox/document store for the standing procedure using the topic or referenced title. Read matching messages/documents in full. |
| Mailbox search misses a referenced communication | Broaden the topic or inspect a bounded relevant message listing, then fetch promising IDs. |
| An existing queue/log/gallery cannot be found by title | Use the available file-list operation; simplify name/type filters, inspect returned metadata, then read candidate workbook tabs and headers. |

Do not exhaust synonyms in one store while another likely store remains
unchecked. After a narrow query and a broader query add no relevant evidence,
advance to the indicated history/listing or another available source. Batch
independent reads. Follow pagination needed for the relevant scope, without
scanning unrelated archives. A permission or disconnected-service error marks
that route unavailable; try a connected source rather than repeating it.

## 3. Test whether the procedure is complete

After each useful source, fill the dependency record. Ask: can the retrieved
material explain **both how records qualify and every required action and
destination afterward**? If it only changes a threshold, exception, metric,
batch code, or reporting route, keep the standing procedure unresolved until
its other requirements are read or already supplied by the user.

Follow explicit references such as "all other rules remain" or "use the prior
format." Also search for the base procedure when the update lacks the action
rules the task requires. A score-based escalation change, for example, does
not by itself define all category-based routing. Do not manufacture missing
branches or silently replace them with the one branch the update describes.

For each amendment, record the affected rule and carry forward compatible
requirements from the standing procedure. Use authority, applicability and
explicit supersession to resolve conflicts, not timestamp alone. Then hand
the resolved rules and references to the operational action ledger.

## 4. Close destination discovery and stop

For each existing destination, retain the actual ID plus evidence of its role
and columns/recipient mapping. Read existing records if the task requires
deduplication. A similar name, a guessed app, or a newly created tab does not
resolve the requested existing resource. Create a resource only when authorized
by the task, not as a substitute for failed discovery.

Stop discovery for resolved needs. If a required dependency is still unavailable
after the relevant bounded routes, retain the specific question and attempted
routes as unresolved. Continue independent authorized actions whose inputs are
complete; do not act on invented policy, recipients, or duplicate-check results.
An unresolved destination cannot support a claim that it was updated.
