"""Pure bounded trajectory queries and public projections for authorized seed sources."""

from __future__ import annotations

import base64
import json
import re
from typing import Any

from gear.canonical import digest


def trajectory_query(input: dict[str, Any]) -> dict[str, Any]:
    query = input.get("query", {})
    if not isinstance(query, dict) or set(query) - {
        "limit",
        "types",
        "seq_start",
        "seq_end",
        "field",
        "cursor",
    }:
        raise ValueError("unknown trajectory query field")
    limit = query.get("limit", 20)
    if type(limit) is not int or not 1 <= limit <= 50:
        raise ValueError("trajectory limit must be between 1 and 50")
    filters: dict[str, Any] = {}
    for key in ("seq_start", "seq_end"):
        if key in query:
            if type(query[key]) is not int or not 0 <= query[key] <= 9007199254740991:
                raise ValueError("trajectory sequence must be a non-negative safe integer")
            filters[key] = query[key]
    if filters.get("seq_start", 0) > filters.get("seq_end", 9007199254740991):
        raise ValueError("trajectory sequence range is reversed")
    if "types" in query:
        values = query["types"]
        if (
            not isinstance(values, list)
            or not 1 <= len(values) <= 50
            or any(
                not isinstance(item, str) or not re.fullmatch(r"[a-zA-Z0-9_./:-]{1,128}", item)
                for item in values
            )
        ):
            raise ValueError("trajectory types require bounded event names")
        filters["types"] = sorted(set(values))
    if "field" in query:
        field = query["field"]
        segment = r"(?:[A-Za-z0-9_-]+|\[field:[a-f0-9]{12}\])"
        if (
            not isinstance(field, str)
            or not 1 <= len(field) <= 1024
            or not re.fullmatch(rf"{segment}(?:\.{segment})*", field)
        ):
            raise ValueError("invalid trajectory field")
        if "seq_start" not in filters or filters["seq_start"] != filters.get("seq_end"):
            raise ValueError("trajectory field requires one exact sequence")
        filters["field"] = field
    binding = {
        "snapshot": input["snapshot_digest"],
        "source": input["source_ref"],
        "content": input["content_digest"],
        "filter": filters,
    }
    provider_cursor = None
    if "cursor" in query:
        cursor = query["cursor"]
        if not isinstance(cursor, str) or len(cursor) > 16384:
            raise ValueError("invalid trajectory cursor")
        try:
            value = json.loads(base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)))
        except (ValueError, UnicodeError) as error:
            raise ValueError("invalid trajectory cursor") from error
        if (
            not isinstance(value, dict)
            or set(value) != {"binding", "provider_cursor"}
            or value["binding"] != digest(binding)
        ):
            raise ValueError("trajectory cursor belongs to another snapshot, source or filter")
        provider_cursor = value["provider_cursor"]
        if not isinstance(provider_cursor, str) or not 1 <= len(provider_cursor) <= 8192:
            raise ValueError("invalid provider cursor")
    return {
        "binding": binding,
        "filter": filters,
        "limit": limit,
        "provider_cursor": provider_cursor,
    }


def trajectory_page(input: dict[str, Any]) -> dict[str, Any]:
    page, query = input["page"], input["query"]
    cursor = page.get("next_cursor")
    if cursor is not None:
        if not isinstance(cursor, str) or not 1 <= len(cursor) <= 8192:
            raise ValueError("invalid provider cursor")
        cursor = (
            base64.urlsafe_b64encode(
                json.dumps(
                    {"binding": digest(query["binding"]), "provider_cursor": cursor},
                    separators=(",", ":"),
                ).encode()
            )
            .decode()
            .rstrip("=")
        )
    body = {
        "version": 1,
        "snapshot_digest": query["binding"]["snapshot"],
        "source_ref": query["binding"]["source"],
        "content_digest": query["binding"]["content"],
        "scope": "canonical-session",
        "child_sessions": "not-included",
        "filter": query["filter"],
        "items": page["events"],
        "total": page["total_matches"],
        "next_cursor": cursor,
        "eof": page["eof"],
        "redactions": page.get("redactions", []),
    }
    if len(json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode()) > 65536:
        raise ValueError("trajectory page exceeds 64 KiB")
    return body
