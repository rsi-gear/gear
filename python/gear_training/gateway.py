"""Generation-only gateway. Native SGLang management APIs never reach agents."""
from __future__ import annotations

import asyncio
import json
import math
import secrets
from .content import ContractError, canonical, digest_bytes, digest_json, require
from .recipes.agent_grpo import effective_sampling
from .samples import token_ids
from .history import ExactChatRenderer, generation_inputs
from .wire import complete_tool_reply


class NativeSGLang:
    def __init__(self, url, expected_weight_version, timeout=900):
        self.url = url.rstrip("/")
        self.expected_weight_version = str(expected_weight_version)
        self.timeout = timeout

    async def generate(self, payload):
        import aiohttp
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=self.timeout)) as session:
            async with session.post(self.url + "/generate", json=payload) as response:
                require(response.status == 200, "native-generation-failed", "SGLang generation failed")
                return await response.json()

    async def abort(self, request_id):
        import aiohttp
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=10)) as session:
            async with session.post(self.url + "/abort_request", json={"rid": request_id}) as response:
                # Acknowledgement of abort does not prove engine quiescence. The
                # controller must additionally drain/stop the engine before reuse.
                return response.status == 200


class ExactGateway:
    def __init__(self, store, ledger, native, runtime_instance_id, tokenizer_digest, template_digest, renderer, parser):
        self.store, self.ledger, self.native = store, ledger, native
        self.runtime_instance_id = runtime_instance_id
        self.tokenizer_digest, self.template_digest = tokenizer_digest, template_digest
        self.renderer, self.parser = renderer, parser
        self.inflight = set()

    async def generate(self, credential, body, idempotency_key=None):
        context = self.ledger.authorize(digest_bytes(credential.encode()), self.runtime_instance_id)
        require(context.get("runId"), "run-not-bound", "Hitch must bind its canonical run before generation")
        require(body.get("model") in (context.get("wireModel"), context["policyVersion"]), "wrong-wire-model", "request model differs from the run-scoped policy")
        require(context["tokenizerDigest"] == self.tokenizer_digest and context["chatTemplateDigest"] == self.template_digest,
                "tokenizer-drift", "gateway tokenizer or template differs from the frozen episode")
        request_id = idempotency_key or "generation_" + secrets.token_hex(16)
        inputs = generation_inputs(self.store, self.ledger, context, body, self.renderer, request_id)
        sampling = effective_sampling(context["sampling"], body, len(inputs), context["maxContextTokens"])
        index, previous = self.ledger.begin_request(context, request_id, digest_json(body), sampling["max_new_tokens"] if "maxRolloutTokens" in context else None)
        if previous:
            receipt = self.store.read_json(previous)
            return self.store.read_json(receipt["rawResponseRef"])["wire"], receipt
        self.inflight.add(request_id)
        payload = {"rid": request_id, "input_ids": inputs, "sampling_params": sampling, "return_logprob": True, "stream": False}
        # Allocate receipt identity before making a request. Its durable request
        # row remains pending until all generated token facts are persisted.
        receipt_id = "receipt_" + secrets.token_hex(16)
        completed_native = False
        try:
            data = await self.native.generate(payload)
            completed_native = True
            meta = data.get("meta_info")
            require(isinstance(meta, dict), "missing-native-metadata", "native generation has no token evidence")
            require(str(meta.get("weight_version")) == self.native.expected_weight_version, "wrong-native-policy", "generation-time server weight version differs from synchronized policy")
            tuples = meta.get("output_token_logprobs")
            require(isinstance(tuples, list) and all(isinstance(t, list) and len(t) >= 2 for t in tuples), "missing-exact-output", "native runtime must return token IDs and logprobs")
            outputs = token_ids([t[1] for t in tuples])
            probs = [t[0] for t in tuples]
            require(all(type(p) in (int, float) and math.isfinite(p) and p <= 0 for p in probs), "invalid-native-logprob", "native behavior logprobs must be finite")
            require(type(meta.get("completion_tokens")) is int and meta["completion_tokens"] == len(outputs), "incomplete-native-output", "terminal output token count differs from native token evidence")
            if "output_ids" in data:
                require(token_ids(data["output_ids"]) == outputs, "native-token-mismatch", "native output IDs disagree with logprob token IDs")
            finish = (meta.get("finish_reason") or {}).get("type")
            require(finish in ("stop", "length", "abort"), "missing-native-terminal", "native stream did not provide a recognized terminal state")
            require(len(outputs) <= sampling["max_new_tokens"], "native-budget-violation", "native runtime exceeded the output limit")
            wire = self.parser(data, body, len(inputs), len(outputs))
            tool_call = wire.get("choices", [{}])[0].get("finish_reason") == "tool_calls"
            receipt = {"schemaVersion": 1, "id": receipt_id, "runId": context["runId"], "episodeId": context["id"],
                       "taskId": context["taskId"], "logicalAttempt": context["logicalAttempt"], "callIndex": index, "requestId": request_id,
                       "policyVersion": context["policyVersion"], "runtimeInstanceId": self.runtime_instance_id,
                       "tokenizerDigest": self.tokenizer_digest, "chatTemplateDigest": self.template_digest,
                       "effectiveSamplingRef": self.store.put_json(sampling), "inputTokenIdsRef": self.store.put_json(inputs),
                       "outputTokenIdsRef": self.store.put_json(outputs), "behaviorLogProbsRef": self.store.put_json(probs),
                       "rawRequestRef": self.store.put_json({"agent": body, "native": payload}),
                       "rawResponseRef": self.store.put_json({"native": data, "wire": wire}),
                       "finishReason": "tool-call" if tool_call and finish == "stop" else finish, "complete": True}
            ref = self.store.put_json(receipt)
            self.ledger.charge("generation/" + request_id, tokens=len(outputs))
            self.ledger.complete_request(request_id, ref)
            return wire, receipt
        except BaseException:
            if completed_native:
                self.ledger.fail_request(request_id, confirmed_stopped=True)
            else:
                try:
                    await asyncio.shield(self.native.abort(request_id))
                except BaseException:
                    pass
                # Keep pending: abort acknowledgement alone is not a barrier.
            raise
        finally:
            self.inflight.discard(request_id)

    def application(self):
        from aiohttp import web

        async def completion(request):
            auth = request.headers.get("Authorization", "")
            if not auth.startswith("Bearer "):
                raise web.HTTPUnauthorized()
            try:
                body = await request.json()
                wire, receipt = await self.generate(auth[7:], body, request.headers.get("Idempotency-Key"))
                headers = {"X-Gear-Receipt-Id": receipt["id"], "X-Gear-Policy-Version": receipt["policyVersion"]}
                if body.get("stream"):
                    # Buffer native generation to completion, then frame the exact
                    # result with Slime's tested wire adapter. No token re-encoding.
                    from slime.agent.adapters.openai import _render_stream
                    choice = wire["choices"][0]
                    response = await _render_stream(request, body, choice["message"], choice["finish_reason"], wire["usage"]["prompt_tokens"], wire["usage"]["completion_tokens"])
                    return response
                return web.json_response(wire, headers=headers)
            except ContractError as error:
                return web.json_response({"error": {"code": error.code, "message": str(error)}}, status=409)

        async def lease_status(request):
            auth = request.headers.get("Authorization", "")
            try:
                require(auth.startswith("Bearer "), "invalid-run-credential", "Bearer credential required")
                context = self.ledger.authorize(digest_bytes(auth[7:].encode()), self.runtime_instance_id)
                lease = self.ledger.lease(context["batchId"])
                return web.json_response({"schemaVersion": 1, "runId": context["runId"], "episodeId": context["id"],
                                          "trainingRunId": lease["trainingRunId"], "policyVersion": lease["policyVersion"],
                                          "fencingToken": lease["fencingToken"], "state": lease["state"],
                                          "generationContractDigest": context["generationContractDigest"], "capture": "exact-policy-tokens-v1"})
            except ContractError as error:
                return web.json_response({"error": error.code}, status=409)

        app = web.Application(client_max_size=32 * 1024 * 1024)
        async def bind_run(request):
            auth = request.headers.get("Authorization", "")
            try:
                require(auth.startswith("Bearer "), "invalid-run-credential", "Bearer credential required")
                body = await request.json()
                context = self.ledger.bind_run(digest_bytes(auth[7:].encode()), self.runtime_instance_id, body.get("runId"), body.get("bindingId"))
                return web.json_response({"runId": context["runId"], "policyVersion": context["policyVersion"]})
            except ContractError as error:
                return web.json_response({"error": error.code}, status=409)
        app.router.add_post("/v1/hitch/run", bind_run)
        app.router.add_post("/v1/chat/completions", completion)
        app.router.add_get("/v1/lease", lease_status)
        # No catch-all forwarding, /generate, /server_info, /update_weights*, or
        # generation session creation. Those belong to the private controller.
        return app


def slime_protocol(tokenizer, tool_parser=None, reasoning_parser=None):
    """Reuse the pinned Slime adapter's template translation and tool parser."""
    from slime.agent.adapters.openai import _translate_messages, _tools_to_chat_tools, _build_reply_parts, _render_response
    from slime.agent.adapters.common import _render_token_ids
    from slime.agent.parsing import parse_model_output

    def render(body, add_generation_prompt):
        messages = body.get("messages")
        require(isinstance(messages, list) and messages, "invalid-messages", "messages must be a nonempty list")
        require(all(isinstance(m, dict) and m.get("role") in ("system", "developer", "user", "assistant", "tool") for m in messages), "unsupported-message", "unknown roles cannot be silently dropped")
        for message in messages:
            content = message.get("content")
            if isinstance(content, list):
                require(all(isinstance(p, dict) and p.get("type") in ("text", "input_text", "output_text") for p in content), "multimodal-unsupported", "v1 exact training is text only")
        return _render_token_ids(_translate_messages(messages), tokenizer, tools=_tools_to_chat_tools(body.get("tools")), add_generation_prompt=add_generation_prompt)

    def parse(data, body, in_tokens, out_tokens):
        outputs = [t[1] for t in data["meta_info"]["output_token_logprobs"]]
        parsed = parse_model_output(tokenizer.decode(outputs, skip_special_tokens=False), tools_schema=_tools_to_chat_tools(body.get("tools")),
                                    tool_parser_name=tool_parser, reasoning_parser_name=reasoning_parser)
        require(not parsed.ill_formed, "ill-formed-tool-output", "model output could not be parsed under the locked tool protocol")
        wire, finish = complete_tool_reply(parsed, data["meta_info"]["finish_reason"]["type"], _build_reply_parts)
        return _render_response(body, wire, finish, in_tokens, out_tokens)

    eos = tokenizer.eos_token_id
    eos_ids = eos if isinstance(eos, list) else [eos] if type(eos) is int else []
    return ExactChatRenderer(render, eos_ids, lambda ids: tokenizer.decode(ids, skip_special_tokens=False)), parse
