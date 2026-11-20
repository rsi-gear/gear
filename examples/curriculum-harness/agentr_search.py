"""Bounded UCT search for the concrete Agent-R retail caller.

Every edge is an observed simulator step. Only distinct completed paths
backpropagate rewards; exhausted but unfinished paths remain unknown.
"""

from __future__ import annotations

import math

from agentr_execution import conversation, extend, grade, restore
from gear.canonical import digest
from gear.core import DeterministicRandom
from gear.curriculum import ModelInput
from sentinel_generate import ACTION_SCHEMA


class RetailTree:
    def __init__(self, initial, *, max_depth, exploration, seed):
        self.nodes = {}
        self.max_depth = max_depth
        self.exploration = exploration
        self.random = DeterministicRandom(str(seed))
        self.root, _ = self.add(None, initial, origin="root")

    def add(self, parent, trace, *, origin, grading=None):
        key = digest([trace["environment_id"], trace["steps"]])
        if key in self.nodes:
            if self.nodes[key]["trace"] != trace or self.nodes[key]["parent"] != parent:
                raise ValueError("Agent-R node identity changed")
            return key, False
        depth = len(trace["steps"])
        if depth > self.max_depth:
            raise ValueError("Agent-R tree depth exceeds the source policy limit")
        if parent is not None and self.nodes[parent]["trace"]["steps"] != trace["steps"][:-1]:
            raise ValueError("Agent-R edge must extend exactly its observed parent")
        self.nodes[key] = {
            "parent": parent,
            "children": [],
            "trace": trace,
            "origin": origin,
            "expanded": False,
            "closed": trace["status"] == "completed" or depth == self.max_depth,
            "visits": 0,
            "value_sum": 0,
            "grading": grading,
        }
        if parent is not None:
            self.nodes[parent]["children"].append(key)
        if grading is not None:
            reward = grading["reward"]
            if reward is not None:
                if (
                    not grading["complete"]
                    or trace["status"] != "completed"
                    or reward not in (0, 1)
                ):
                    raise ValueError("only complete native verdicts backpropagate")
                current = key
                while current is not None:
                    self.nodes[current]["visits"] += 1
                    self.nodes[current]["value_sum"] += reward
                    current = self.nodes[current]["parent"]
        return key, True

    def close(self, key):
        while key is not None:
            node = self.nodes[key]
            node["closed"] = node["closed"] or (
                node["expanded"] and all(self.nodes[child]["closed"] for child in node["children"])
            )
            key = node["parent"]

    def select(self, key, iteration):
        parent = self.nodes[key]
        scores = {}
        for child in parent["children"]:
            node = self.nodes[child]
            if node["closed"]:
                continue
            count = node["visits"]
            scores[child] = (
                node["value_sum"] / count
                + self.exploration * math.sqrt(math.log(max(1, parent["visits"])) / count)
                if count
                else None
            )
        if not scores:
            raise ValueError("cannot descend a closed Agent-R node")
        selected = max(
            scores,
            key=lambda child: (
                scores[child] is None,
                scores[child] if scores[child] is not None else 0,
                self.random.value(key + "/" + child, iteration),
                child,
            ),
        )
        # null explicitly means unvisited, never a JSON Infinity or a zero reward.
        return selected, {"parent": key, "selected": selected, "uct": scores}


async def search(caller):
    backend, config = caller.backend, caller.source_config
    session, initial = restore(backend, config, [])
    tree = RetailTree(
        initial,
        max_depth=config["max_steps"],
        exploration=caller.config["exploration"],
        seed=caller.config["seed"],
    )
    source = caller.source["trajectory"]
    parent = tree.root
    for length in range(1, len(source["steps"]) + 1):
        _, prefix = restore(backend, config, source["steps"][:length])
        parent, _ = tree.add(
            parent,
            prefix,
            origin="observed-source",
            grading=caller.source_grading if length == len(source["steps"]) else None,
        )
    failure = parent
    iterations = []
    for iteration in range(caller.config["iterations"]):
        if tree.nodes[tree.root]["closed"]:
            break
        key, decisions = tree.root, []
        while not tree.nodes[key]["closed"]:
            node = tree.nodes[key]
            if not node["expanded"]:
                samples = []
                for index in range(caller.config["branch_samples"]):
                    call_key = f"tree/{key}/sample/{index}"
                    response = await caller.model_json(
                        call_key + "/action",
                        ModelInput(
                            config["harness"],
                            ACTION_SCHEMA,
                            {
                                "policy": backend["policy"],
                                "tools": session.tool_schemas(),
                                "conversation": conversation(node["trace"]),
                            },
                        ),
                    )
                    trace = await extend(
                        backend,
                        config,
                        node["trace"]["steps"],
                        response,
                        caller.model_json,
                        call_key,
                    )
                    child = digest([trace["environment_id"], trace["steps"]])
                    duplicate = child in tree.nodes
                    if not duplicate:
                        verdict = await grade(
                            backend, config, caller.task, trace, caller.model_json, call_key
                        )
                        tree.add(key, trace, origin=call_key, grading=verdict)
                    elif tree.nodes[child]["trace"] != trace:
                        raise ValueError("duplicate Agent-R action produced changed observations")
                    samples.append({"key": call_key, "node": child, "duplicate": duplicate})
                node["expanded"] = True
                tree.close(key)
                caller.checkpoint("expansions/" + key, {"samples": samples, "node": node})
                if node["closed"]:
                    break
            key, decision = tree.select(key, iteration)
            decisions.append(decision)
        iterations.append({"iteration": iteration, "decisions": decisions, "stopped_at": key})
        caller.checkpoint("iterations/" + str(iteration), iterations[-1])
    return caller.checkpoint(
        "tree",
        {
            "root": tree.root,
            "source_failure": failure,
            "nodes": tree.nodes,
            "iterations": iterations,
            "stop": "exhausted" if tree.nodes[tree.root]["closed"] else "iteration_limit",
        },
    )


def select_pair(tree):
    """Use the original failure; prefer a verified success with the longest prefix."""
    failed = tree["nodes"][tree["source_failure"]]
    if failed["grading"]["reward"] != 0 or not failed["grading"]["complete"]:
        raise ValueError("Agent-R pairing requires the original complete failure")
    pairs = []
    for key, node in tree["nodes"].items():
        if node["grading"] is None or node["grading"]["reward"] != 1:
            continue
        common = 0
        for left, right in zip(failed["trace"]["steps"], node["trace"]["steps"], strict=False):
            if left != right:
                break
            common += 1
        pairs.append(
            {
                "failure": tree["source_failure"],
                "success": key,
                "common_steps": common,
                "reward_gap": 1,
                "success_steps": len(node["trace"]["steps"]),
            }
        )
    return (
        min(pairs, key=lambda row: (-row["common_steps"], row["success_steps"], row["success"]))
        if pairs
        else None
    )
