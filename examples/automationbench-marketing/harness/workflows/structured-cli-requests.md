# Structured CLI requests

Keep the reviewed request as readable JSON. Let code handle quoting, nested
serialization, and encoding; carry encoded output directly into the destination
call without copying it through a model message.

Use this procedure only with the adapter, tool names, and argument schema
provided by the current task. It does not discover endpoints, decide recipients,
select records, or authorize writes. Resolve those with the operational workflow.

## Prepare and invoke

1. Read the actual tool schema and any endpoint schema. Identify which CLI
   fields require JSON strings, and which leaf fields require base64url.
   Native structured tools should receive objects directly; do not wrap them.
2. Prepare one request JSON file in the task's permitted scratch area using the
   normal file-writing tool. Keep text and source values exactly as reviewed.
   Use objects/arrays for nested request data, not escaped JSON inside strings.
   A single-quoted here-document on stdin also works; do not interpolate message
   content into a shell command or change punctuation to make quoting easier.
3. Invoke the absolute helper path supplied in the harness guidance:

   ~~~sh
   python HELPER_PATH REQUEST_FILE
   ~~~

   Both paths must be actual paths, shell-quoted as needed. The helper also accepts
   a dash (-) for JSON on stdin. It calls the task's existing CLI using an argv
   array with one serialized JSON argument, without a shell.
4. Inspect the actual adapter response. The helper forwards its output and exit
   status; exit zero is not delivery proof. Inspect application error fields and
   reconcile the returned ID/content or focused readback with the reviewed
   request. Record the receipt before any dependent update.

Request shape (replace explanatory placeholders with values from the task):

~~~json
{
  "command": ["python", "ACTUAL_ADAPTER_PATH", "ACTUAL_TOOL_NAME"],
  "arguments": {
    "method": "POST",
    "url": "EXACT_DISCOVERED_ENDPOINT",
    "params": null,
    "body": {"text": "Reviewed text with an apostrophe: it's ready.\nSecond line."}
  },
  "json_fields": ["params", "body"]
}
~~~

The command array is the exact existing CLI prefix and tool name, without its
final JSON argument. Never use a shell command string here. Only invoke tools the
task permits; this helper adds no network client or alternate app access.

The arguments object is the tool's argument object. The json_fields array lists
only top-level fields whose schema requires a JSON string. The helper serializes
those fields once, preserving null, empty objects/arrays and their contents, then
serializes the outer object. Omit json_fields for a CLI that accepts nested objects.
Do not use literal placeholders, encode the whole request, or guess field names.

## Base64url without manual copying

If a listed local encoding tool accepts a plaintext text argument and returns
a base64url string, add its exact CLI argv as encoder_command. Put the original
plaintext in each field to encode and list the path as an array of object keys.
The helper runs that encoder, validates that decoding reproduces the exact UTF-8
plaintext, and passes the returned value directly into the destination request.
It performs all encoding before the single destination call.

For an endpoint whose schema explicitly accepts a message payload with
headers and body.data, the request can have this form:

~~~json
{
  "command": ["python", "ACTUAL_ADAPTER_PATH", "ACTUAL_SEND_TOOL"],
  "arguments": {
    "method": "POST",
    "url": "EXACT_DISCOVERED_SEND_ENDPOINT",
    "params": null,
    "body": {
      "payload": {
        "headers": [
          {"name": "To", "value": "ACTUAL_AUTHORIZED_RECIPIENT"},
          {"name": "Subject", "value": "REVIEWED_SUBJECT"}
        ],
        "body": {"data": "REVIEWED_PLAINTEXT_BODY"}
      }
    }
  },
  "json_fields": ["params", "body"],
  "encoder_command": ["python", "ACTUAL_ADAPTER_PATH", "ACTUAL_ENCODING_TOOL"],
  "base64url_fields": [["body", "payload", "body", "data"]]
}
~~~

These are schema examples, not assumed API contracts. For a raw message field,
the plaintext must be a complete valid RFC message, including headers and body.
Construct MIME headers with a standard library when needed, especially for
non-ASCII subjects; base64 encoding alone does not make malformed MIME valid.
For an encoding tool with a different schema or return shape, use a small
programmatic pipeline through that listed tool and validate the round-trip;
do not guess a response shape or copy a long encoded string by hand.

For multi-record requests, build the readable arguments from the existing
source/action ledger in code and reuse that same object. A serializer preserves
the supplied values; it cannot catch selecting the wrong record or omitting a
required field. Reconcile recipients, record keys, counts and required literals
before invoking it.

## Recovery

Preparation failure means this helper did not call the destination. Fix the
readable request and retry preparation. Once the destination was invoked,
use its response or existing-state lookup to distinguish rejection from success
or uncertainty before repeating a write. The helper never retries automatically.
For a confirmed send, changing or deleting the local request does not recall it.
Do not issue another send solely to repair cosmetic wording.
