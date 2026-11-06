"""Validated GRPO groups and independently verified SFT supervision."""

from dataclasses import asdict

from gear.training.data.samples import admit_group, build_episode
from gear.training.recipes.registry import zero_variance_policy
from gear.training.storage.content import ContractError, require


class GRPODatasetBuilder:
    def __init__(self, store, request):
        self.store, self.request = store, request

    async def build(self, trajectories):
        samples = []
        for raw in trajectories:
            samples.append(
                build_episode(
                    self.store,
                    self.store.read_json(raw.episode_ref),
                    [self.store.read_json(ref) for ref in raw.receipt_refs],
                    self.store.read_json(raw.feedback_ref),
                    self.store.read_json(raw.context_ref),
                    assembly=self.store.read_json(raw.assembly_ref) if raw.assembly_ref else None,
                )
            )
        return admit_group(
            samples,
            self.request["rollout"]["groupSize"],
            zero_variance_policy(self.request),
        )


class SFTDatasetBuilder:
    """Data construction only. Prefix requires explicit independent step evidence.

    A final failure/score never implies a first error boundary. Exact receipts
    are copied by the trusted builder; an agent may only select a verified cut.
    """

    def __init__(self, store):
        self.store = store

    async def build(self, trajectories, *, verifications=None):
        prefixes = verifications or {}
        samples = []
        for raw in trajectories:
            if raw.episode_ref.get("digest") is None:
                raise ContractError("invalid-trajectory", "trajectory is not sealed")
            episode = self.store.read_json(raw.episode_ref)
            feedback = self.store.read_json(raw.feedback_ref)
            context = self.store.read_json(raw.context_ref)
            selected = list(raw.receipt_refs)
            proof_ref = prefixes.get(episode["id"])
            if not proof_ref:
                continue
            proof = self.store.read_json(proof_ref)
            count = proof.get("receiptCount", len(selected))
            require(
                proof.get("kind") in ("verified-success", "verified-prefix")
                and proof.get("episodeId") == episode["id"]
                and proof.get("runId") == episode["runId"]
                and type(count) is int
                and 0 < count <= len(selected)
                and proof.get("verified") is True
                and proof.get("receiptDigests") == [ref["digest"] for ref in selected[:count]],
                "invalid-prefix-proof",
                "selection needs independently verified ordered receipt evidence",
            )
            require(
                proof["kind"] != "verified-success"
                or count == len(selected)
                and episode.get("termination") == "terminated"
                and feedback.get("outcome") == "valid",
                "invalid-success-proof",
                "success requires a valid complete canonical episode",
            )
            self.store.read_bytes(proof["evidenceRef"])
            from gear.training.data.samples import build_capture

            sample = build_capture(
                self.store,
                episode,
                [self.store.read_json(ref) for ref in raw.receipt_refs],
                feedback,
                context,
                receipt_count=count,
                assembly=self.store.read_json(raw.assembly_ref) if raw.assembly_ref else None,
            )
            samples.append(
                {
                    "tokens": sample.tokens,
                    "responseLength": sample.response_length,
                    "lossMask": sample.loss_mask,
                    "sourceTrajectory": asdict(raw),
                    "prefixProofRef": prefixes.get(episode["id"]),
                }
            )
        return self.store.put_json({"schemaVersion": 1, "kind": "sft-dataset", "samples": samples})
