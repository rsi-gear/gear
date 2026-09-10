"""Immutable OS-boot evidence for explicitly draining prior node generations."""
from pathlib import Path

from .content import atomic_json, digest_json, require
from .state import load


def generation_path(root, node):
    return Path(root) / "generations" / (digest_json(node)[7:] + ".json")


def record_generation(root, identity):
    require(isinstance(identity, dict) and set(identity) == {"nodeId", "generation", "bootIdentity"}
            and all(isinstance(v, str) and v for v in identity.values()),
            "invalid-node-generation", "node generation requires its OS boot identity")
    node = {key: identity[key] for key in ("nodeId", "generation")}
    path = generation_path(root, node)
    existing = load(path)
    require(existing is None or existing == identity, "node-generation-history-drift", "node generation boot evidence changed")
    if existing is None: atomic_json(path, identity)


def archived_boot_digest(root, node):
    require(isinstance(node, dict) and set(node) == {"nodeId", "generation"}
            and all(isinstance(v, str) and v for v in node.values()), "invalid-node-generation", "invalid archived node identity")
    identity = load(generation_path(root, node))
    require(identity and set(identity) == {"nodeId", "generation", "bootIdentity"}
            and all(identity.get(k) == v for k, v in node.items()) and isinstance(identity.get("bootIdentity"), str) and identity["bootIdentity"],
            "previous-boot-unproven", "node generation has no intact archived OS boot identity")
    return digest_json(identity["bootIdentity"])


def previous_boot_proof(root, current, previous):
    require(isinstance(previous, dict) and set(previous) == {"nodeId", "generation"}
            and previous.get("nodeId") == current.get("nodeId") and previous != current,
            "invalid-previous-generation", "recovery requires a prior generation of this same node")
    actual = load(Path(root) / "identity.json")
    require(actual and all(actual.get(k) == v for k, v in current.items()),
            "node-generation-drift", "recovery caller no longer owns the current generation")
    prior = load(generation_path(root, previous))
    require(prior and all(prior.get(k) == v for k, v in previous.items())
            and isinstance(prior.get("bootIdentity"), str) and prior["bootIdentity"]
            and isinstance(actual.get("bootIdentity"), str) and actual["bootIdentity"]
            and prior["bootIdentity"] != actual["bootIdentity"],
            "previous-boot-unproven", "prior generation has no distinct archived OS boot identity")
    return {"previousBootDigest": digest_json(prior["bootIdentity"]), "currentBootDigest": digest_json(actual["bootIdentity"])}
