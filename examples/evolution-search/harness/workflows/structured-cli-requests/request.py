"""Serialize JSON CLI requests without shell interpolation or encoded-text copying."""
import base64
import binascii
import json
import re
import subprocess
import sys


def json_text(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"))


def command_vector(value, label):
    if not isinstance(value, list) or not value or any(
        not isinstance(part, str) or not part or "\x00" in part for part in value
    ):
        raise ValueError(label + " must be a nonempty argv array of nonempty strings")
    return value


def field_location(arguments, path):
    if not isinstance(path, list) or not path:
        raise ValueError("Each base64url field path must be a nonempty array")
    parent = arguments
    for key in path[:-1]:
        if not isinstance(parent, dict) or not isinstance(key, str) or key not in parent:
            raise ValueError("Missing object in base64url field path")
        parent = parent[key]
    key = path[-1]
    if not isinstance(parent, dict) or not isinstance(key, str) or key not in parent:
        raise ValueError("Missing base64url field")
    if not isinstance(parent[key], str):
        raise ValueError("A base64url field must contain the reviewed plaintext string")
    return parent, key


def encode_text(command, plaintext):
    # The task's listed encoder is called through the same authorized CLI.
    result = subprocess.run(
        command + [json_text({"text": plaintext})],
        capture_output=True, text=True, encoding="utf-8", shell=False,
    )
    if result.returncode:
        sys.stderr.write(result.stderr)
        raise ValueError("Encoder failed; destination command was not called")
    output = result.stdout.strip()
    try:
        encoded = json.loads(output)
    except json.JSONDecodeError:
        encoded = output
    if not isinstance(encoded, str) or not re.fullmatch(r"[A-Za-z0-9_-]*={0,2}", encoded):
        raise ValueError("Encoder did not return a base64url string; destination was not called")
    try:
        decoded = base64.b64decode(
            encoded + "=" * (-len(encoded) % 4), altchars=b"-_", validate=True
        )
    except (ValueError, binascii.Error) as exc:
        raise ValueError("Encoder returned invalid base64url; destination was not called") from exc
    if decoded != plaintext.encode("utf-8"):
        raise ValueError("Encoder round-trip changed the plaintext; destination was not called")
    return encoded


def prepare(spec):
    if not isinstance(spec, dict):
        raise ValueError("Request must be a JSON object")
    allowed = {"command", "arguments", "json_fields", "base64url_fields", "encoder_command"}
    if set(spec) - allowed:
        raise ValueError("Unknown request fields: " + ", ".join(sorted(set(spec) - allowed)))
    command = command_vector(spec.get("command"), "command")
    arguments = spec.get("arguments")
    if not isinstance(arguments, dict):
        raise ValueError("arguments must be an object")
    # A separate tree prevents transformations from changing the reviewed request.
    arguments = json.loads(json_text(arguments))
    fields = spec.get("json_fields", [])
    if not isinstance(fields, list) or any(not isinstance(field, str) for field in fields):
        raise ValueError("json_fields must be an array of top-level field names")
    if len(fields) != len(set(fields)):
        raise ValueError("json_fields must not contain duplicates")
    for field in fields:
        if field not in arguments or (
            arguments[field] is not None and not isinstance(arguments[field], (dict, list))
        ):
            raise ValueError("Each json_fields value must be an object, array, or null; do not pre-serialize")
    paths = spec.get("base64url_fields", [])
    if not isinstance(paths, list):
        raise ValueError("base64url_fields must be an array of field paths")
    # Validate every field before invoking even the local encoder.
    locations = [field_location(arguments, path) for path in paths]
    keys = [json_text(path) for path in paths]
    if len(keys) != len(set(keys)):
        raise ValueError("base64url_fields must not contain duplicates")
    encoder = command_vector(spec.get("encoder_command"), "encoder_command") if paths else None
    for parent, key in locations:
        parent[key] = encode_text(encoder, parent[key])
    for field in fields:
        if arguments[field] is not None:
            arguments[field] = json_text(arguments[field])
    return command + [json_text(arguments)]


def main():
    if len(sys.argv) != 2:
        sys.stderr.write("Usage: python request.py REQUEST.json (or - for JSON on stdin)\n")
        return 2
    try:
        if sys.argv[1] == "-":
            spec = json.load(sys.stdin)
        else:
            with open(sys.argv[1], encoding="utf-8") as source:
                spec = json.load(source)
        argv = prepare(spec)
    except (ValueError, OSError) as exc:
        sys.stderr.write("Request preparation failed: " + str(exc) + "\n")
        return 2
    # One destination call, no retries. Preserve its stdout, stderr, and exit status.
    # An API can report an application error in JSON even when this status is zero.
    try:
        return subprocess.run(argv, shell=False).returncode
    except OSError as exc:
        sys.stderr.write("Could not start destination command: " + str(exc) + "\n")
        return 2


if __name__ == "__main__":
    sys.exit(main())
