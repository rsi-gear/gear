"""Frozen local HF solver inference for challenger rewards and construction.

Only the solver's mathematical agreement is measured here. Completion feedback
verifies a finished text generation, never answer correctness. These captures
are not submitted as solver gradient samples. The training caller owns the
challenger lease and its separate, existing Slime optimizer.
"""

from __future__ import annotations

import threading
import time
from pathlib import Path

from gear.training.data import samples
from gear.training.data.samples import build_episode
from gear.training.data.trajectories import RawTrajectory
from gear.training.recipes import agent_grpo, diagevo_backends
from gear.training.recipes.agent_grpo import effective_sampling, sampling_params
from gear.training.recipes.diagevo_backends import (
    _directory,
    _finish,
    _freeze,
    _initialize,
    _reserve,
    _saved,
)
from gear.training.runtime.implementation import stage_identity
from gear.training.storage import snapshots
from gear.training.storage.content import require
from gear.training.storage.loop_journal import _MISSING, _digest, _read
from gear.training.storage.snapshots import materialize, seal_directory
from gear.training.storage.state import lock


class FrozenHFSolver:
    """CPU float32 text sampling from exact model bytes, with durable call keys.

    A key has a private CPU RNG seed and at most one published result. Local
    recomputation after an interrupted forward pass is permitted; there is no
    external server or paid request to reconcile. Logical runtime identity binds
    the frozen model/configuration, rather than asserting a surviving process.
    """

    stage_id = "gear.diagevo.frozen-hf-solver:v1"
    source_dependencies = tuple(
        Path(module.__file__) for module in (diagevo_backends, agent_grpo, samples, snapshots)
    )
    package_dependencies = ("torch", "transformers", "tokenizers", "safetensors")

    def __init__(
        self,
        store,
        root,
        *,
        model_ref,
        instruction,
        max_new_tokens=1024,
        max_context_tokens=4096,
        max_calls=4096,
        max_seconds=300,
        seed=0,
    ):
        require(
            isinstance(instruction, str)
            and instruction.strip()
            and len(instruction) <= 16384
            and type(seed) is int
            and 0 <= seed < 2**53
            and type(max_new_tokens) is int
            and 0 < max_new_tokens <= 32768
            and type(max_context_tokens) is int
            and max_new_tokens < max_context_tokens <= 131072
            and type(max_calls) is int
            and 0 < max_calls <= 1000000
            and type(max_seconds) is int
            and 0 < max_seconds <= 3600,
            "diagevo-frozen-solver-config",
            "frozen solver needs explicit instructions, seed and bounded CPU generation",
        )
        self.store, self.root = store, Path(root)
        self.model_ref, self.instruction = model_ref, instruction
        self.max_calls, self.seed = max_calls, seed
        self.max_seconds = max_seconds
        self.max_context_tokens = max_context_tokens
        self.sampling = sampling_params(
            {
                "sampling": dict(
                    temperature=1,
                    topP=1,
                    topK=-1,
                    repetitionPenalty=1,
                    maxNewTokens=max_new_tokens,
                )
            }
        )
        self.manifest = store.read_json(model_ref)
        require(
            self.manifest.get("format") == "hf-safetensors"
            and self.manifest.get("schemaVersion") == 1,
            "diagevo-frozen-solver-model",
            "solver requires an existing immutable HF snapshot",
        )
        self.identity = {
            "implementation": stage_identity(self),
            "modelRef": model_ref,
            "instruction": instruction,
            "sampling": self.sampling,
            "maxContextTokens": max_context_tokens,
            "maxCalls": max_calls,
            "maxSeconds": max_seconds,
            "seed": seed,
            "device": "cpu",
            "dtype": "float32",
            "truncation": False,
        }
        _initialize(self.root, self.identity)
        self.policy_id = "frozen-hf/" + model_ref["digest"]
        self.runtime_id = "local-hf/" + _digest(self.identity)
        self.model = self.tokenizer = None

    def _load(self):
        if self.model is not None:
            return
        import torch
        from transformers import AutoModelForCausalLM, AutoTokenizer

        directory = materialize(self.store, self.model_ref, self.root / "model")
        require(
            seal_directory(self.store, directory, serving=True, verify_finite=True)
            == self.model_ref,
            "diagevo-frozen-solver-model",
            "model snapshot metadata must match its actual safe serving files",
        )
        tokenizer = AutoTokenizer.from_pretrained(
            directory, local_files_only=True, trust_remote_code=False
        )
        with torch.random.fork_rng(devices=[]):
            model = (
                AutoModelForCausalLM.from_pretrained(
                    directory,
                    local_files_only=True,
                    trust_remote_code=False,
                    use_safetensors=True,
                    dtype=torch.float32,
                    attn_implementation="eager",
                )
                .to("cpu")
                .eval()
            )
        context = getattr(model.config, "max_position_embeddings", None)
        context = context or getattr(model.config, "n_positions", None)
        eos = model.generation_config.eos_token_id
        eos = [eos] if type(eos) is int else eos
        require(
            type(context) is int
            and self.max_context_tokens <= context
            and isinstance(eos, list)
            and eos
            and all(type(token) is int and 0 <= token < model.config.vocab_size for token in eos)
            and isinstance(tokenizer.chat_template, str)
            and tokenizer.chat_template,
            "diagevo-frozen-solver-model",
            "solver needs a bounded decoder context, EOS tokens and one chat template",
        )
        self.tokenizer, self.model, self.eos = tokenizer, model, eos
        for parameter in self.model.parameters():
            parameter.requires_grad_(False)

    def _generate(self, messages, seed):
        import torch
        from transformers import GenerationConfig

        self._load()
        inputs = self.tokenizer.apply_chat_template(
            messages, tokenize=True, add_generation_prompt=True, return_dict=False, truncation=False
        )
        require(
            isinstance(inputs, list) and inputs and all(type(token) is int for token in inputs),
            "diagevo-frozen-solver-input",
            "chat template must produce one complete token sequence",
        )
        sampling = effective_sampling(self.sampling, {}, len(inputs), self.max_context_tokens)
        config = GenerationConfig(
            do_sample=True,
            temperature=1.0,
            top_p=1.0,
            top_k=0,
            repetition_penalty=1.0,
            max_new_tokens=sampling["max_new_tokens"],
            eos_token_id=self.eos,
            pad_token_id=self.eos[0],
            use_cache=True,
            return_dict_in_generate=True,
            output_scores=True,
            max_time=float(self.max_seconds),
        )
        tensor = torch.tensor([inputs], dtype=torch.long)
        started = time.monotonic()
        # HF generation uses the CPU global RNG. This synchronous main-thread
        # region restores it and does not seed or initialize any CUDA generator.
        with torch.random.fork_rng(devices=[]), torch.inference_mode():
            torch.random.default_generator.manual_seed(seed)
            result = self.model.generate(
                input_ids=tensor, attention_mask=torch.ones_like(tensor), generation_config=config
            )
            outputs = result.sequences[0, len(inputs) :].tolist()
            logprobs = [
                float(torch.log_softmax(scores[0].float(), dim=-1)[token])
                for scores, token in zip(result.scores, outputs, strict=True)
            ]
        return {
            "inputTokenIds": inputs,
            "outputTokenIds": outputs,
            "behaviorLogProbs": logprobs,
            "effectiveSampling": sampling,
            "text": self.tokenizer.decode(outputs, skip_special_tokens=True),
            "finishReason": "stop" if outputs and outputs[-1] in self.eos else "length",
            "seconds": time.monotonic() - started,
        }

    def _capture(self, request, generated):
        key, question_id, messages = request["key"], request["questionId"], request["messages"]
        name = "local-diagevo/" + _digest(request)[7:]
        task = self.store.put_json(
            {
                "kind": "diagevo-solver-question",
                "id": question_id,
                "question": messages[-1]["content"],
            }
        )
        harness = self.store.put_json(
            {"kind": "diagevo-text-solver", "instruction": self.instruction}
        )
        environment = self.store.put_json(
            {"kind": "local-hf-text-inference", "backend": self.identity}
        )
        verification = self.store.put_json(
            {"kind": "diagevo-completion-only", "version": 1, "correctnessAssessed": False}
        )
        context = {
            "id": name,
            "runId": name + "/run",
            "groupId": _digest([request["groupKey"], question_id]),
            "slot": request["slot"],
            "taskId": question_id,
            "logicalAttempt": 1,
            "policyVersion": self.policy_id,
            "runtimeInstanceId": self.runtime_id,
            "tokenizerDigest": self.manifest["tokenizerDigest"],
            "chatTemplateDigest": self.manifest["chatTemplateDigest"],
            "harnessRef": harness,
            "taskRef": task,
            "environmentRef": environment,
            "sampling": self.sampling,
            "maxContextTokens": self.max_context_tokens,
            "maxEpisodeSteps": 1,
            "verifierVersion": verification["digest"],
        }
        receipt = {
            "schemaVersion": 1,
            "id": name + "/receipt",
            "episodeId": name,
            "callIndex": 0,
            "requestId": key,
            **{
                field: context[field]
                for field in (
                    "runId",
                    "taskId",
                    "logicalAttempt",
                    "policyVersion",
                    "runtimeInstanceId",
                    "tokenizerDigest",
                    "chatTemplateDigest",
                )
            },
            "effectiveSamplingRef": self.store.put_json(generated["effectiveSampling"]),
            "inputTokenIdsRef": self.store.put_json(generated["inputTokenIds"]),
            "outputTokenIdsRef": self.store.put_json(generated["outputTokenIds"]),
            "behaviorLogProbsRef": self.store.put_json(generated["behaviorLogProbs"]),
            "rawRequestRef": self.store.put_json(
                {
                    "agent": {"messages": messages},
                    "native": {
                        "backend": self.identity,
                        "seed": request["seed"],
                        "input_ids": generated["inputTokenIds"],
                    },
                }
            ),
            "rawResponseRef": self.store.put_json(
                {
                    "native": generated,
                    "wire": {
                        "choices": [
                            {
                                "finish_reason": generated["finishReason"],
                                "message": {"role": "assistant", "content": generated["text"]},
                            }
                        ]
                    },
                }
            ),
            "finishReason": generated["finishReason"],
            "complete": True,
        }
        feedback = {
            "schemaVersion": 1,
            "id": name + "/feedback",
            "episodeId": name,
            "runId": context["runId"],
            "receiptIds": [receipt["id"]],
            "verifierVersion": verification["digest"],
            "verifierEvidenceRef": verification,
            "outcome": "valid",
            "reward": 0,
        }
        episode = {
            "schemaVersion": 1,
            **{
                field: context[field]
                for field in (
                    "id",
                    "groupId",
                    "slot",
                    "runId",
                    "policyVersion",
                    "harnessRef",
                    "taskRef",
                    "environmentRef",
                )
            },
            "receiptIds": feedback["receiptIds"],
            "feedbackId": feedback["id"],
            "termination": "terminated",
            "eligibility": "eligible",
            "rejectionReasons": [],
        }
        build_episode(self.store, episode, [receipt], feedback, context)
        return RawTrajectory(
            self.store.put_json(episode),
            self.store.put_json(feedback),
            [self.store.put_json(receipt)],
            self.store.put_json(context),
        )

    async def sample(self, group_key, questions, *, count, check_cancel=lambda: None):
        require(
            threading.current_thread() is threading.main_thread()
            and isinstance(group_key, str)
            and group_key
            and isinstance(questions, dict)
            and all(
                isinstance(k, str) and k and isinstance(v, str) and v.strip() and len(v) <= 262144
                for k, v in questions.items()
            )
            and type(count) is int
            and 0 < count <= 256,
            "diagevo-frozen-solver-input",
            "solver sampling requires bounded questions and complete groups on the main thread",
        )
        group_root = self.root / "groups" / _digest(group_key)[7:]
        with lock(group_root / "input.lock", blocking=False):
            _freeze(
                group_root / "input.json",
                {
                    "key": group_key,
                    "backend": self.identity,
                    "questions": questions,
                    "count": count,
                },
            )
        captures = {}
        for question_id in sorted(questions):
            captures[question_id] = []
            for slot in range(count):
                check_cancel()
                key = _digest([group_key, question_id, slot])
                request = {
                    "key": key,
                    "backend": self.identity,
                    "groupKey": group_key,
                    "questionId": question_id,
                    "slot": slot,
                    "seed": int(_digest([self.seed, key])[7:23], 16) % 2**53,
                    "messages": [
                        {"role": "system", "content": self.instruction},
                        {"role": "user", "content": questions[question_id]},
                    ],
                }
                directory = _directory(self.root, key)
                with lock(directory / "call.lock", blocking=False):
                    saved = _saved(directory, request)
                    if saved is None:
                        pending = _read(directory / "pending.json")
                        if pending is _MISSING:
                            _reserve(self.root, directory, request, self.max_calls)
                        else:
                            require(
                                pending["request"] == request,
                                "diagevo-backend-drift",
                                "frozen solver input changed",
                            )
                        generated = self._generate(request["messages"], request["seed"])
                        saved = _finish(
                            directory, request, {"request": request, "generation": generated}
                        )
                    # Persist even a truncated response, so a retry cannot turn
                    # its slot into a different accepted mathematical answer.
                    require(
                        saved["generation"]["finishReason"] == "stop",
                        "diagevo-frozen-solver-incomplete",
                        "solver response did not reach EOS",
                    )
                    captures[question_id].append(self._capture(request, saved["generation"]))
        return captures
