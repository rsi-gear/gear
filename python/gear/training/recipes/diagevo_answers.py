"""Math-Verify answer classes bound to captured DiagEvo solver responses.

Classes express agreement under this frozen parser/comparator, not correctness.
Missing or unsupported final answers have distinct non-answer identities;
library errors and timeouts stop construction instead of becoming disagreements.
"""

from __future__ import annotations

import re
import threading
import time
from dataclasses import asdict
from pathlib import Path

from gear.training.data.trajectories import RawTrajectory
from gear.training.recipes import diagevo_data
from gear.training.recipes.diagevo_data import _capture
from gear.training.runtime.implementation import stage_identity
from gear.training.storage.content import digest_json, require


def _last_box(text):
    pattern = re.compile(r"\\boxed\s*\{")
    cursor, result = 0, (None, "missing_box")
    while match := pattern.search(text, cursor):
        start = match.end()
        depth, index = 1, start
        while index < len(text):
            char = text[index]
            if char == "\\":
                index += 2
                continue
            if char == "{":
                depth += 1
            elif char == "}":
                depth -= 1
                if depth == 0:
                    break
            index += 1
        if depth:
            return None, "unbalanced_box"
        body = text[start:index]
        # A nested box is ambiguous. Never accidentally extract its inner
        # answer instead of the final outer expression, or use an older box.
        result = (
            (None, "nested_box") if pattern.search(body) else (r"\boxed{" + body + "}", "boxed")
        )
        cursor = index + 1
    return result


def _check_deadline(deadline):
    require(
        time.monotonic() < deadline,
        "diagevo-classifier-deadline",
        "mathematical classification exceeded its soft wall-clock budget",
    )


class DiagEvoMathClassifier:
    stage_id = "gear.diagevo.math-verify:v1"
    source_dependencies = (Path(diagevo_data.__file__),)
    package_dependencies = (
        "math-verify",
        "latex2sympy2_extended",
        "antlr4-python3-runtime",
        "sympy",
        "mpmath",
    )

    def __init__(
        self,
        store,
        *,
        timeout_seconds=5,
        float_rounding=6,
        numeric_precision=15,
        max_response_characters=262144,
        max_responses_per_question=256,
        max_seconds=300,
    ):
        self.store = store
        self.parameters = dict(
            timeout_seconds=timeout_seconds,
            float_rounding=float_rounding,
            numeric_precision=numeric_precision,
            max_response_characters=max_response_characters,
            max_responses_per_question=max_responses_per_question,
            max_seconds=max_seconds,
        )
        require(
            all(type(value) is int and value > 0 for value in self.parameters.values())
            and timeout_seconds <= 60
            and max_seconds <= 3600
            and float_rounding <= numeric_precision <= 100,
            "diagevo-classifier-config",
            "classifier limits and precision must be positive bounded integers",
        )

    def identity(self):
        return {
            "kind": self.stage_id,
            "implementation": stage_identity(self),
            "parameters": self.parameters,
        }

    def _backend(self):
        require(
            threading.current_thread() is threading.main_thread(),
            "diagevo-classifier-thread",
            "Math-Verify timeouts require the worker's main thread",
        )
        # Do not let the library's SIGALRM implementation cancel an existing
        # owner deadline. The native driver normally has no interval timer.
        import signal

        if hasattr(signal, "getitimer"):
            require(
                signal.getitimer(signal.ITIMER_REAL) == (0.0, 0.0),
                "diagevo-classifier-timer",
                "classification needs an unoccupied worker alarm",
            )
        from latex2sympy2_extended import NormalizationConfig
        from math_verify import LatexExtractionConfig, parse
        from sympy import Basic, MatrixBase, srepr

        config = LatexExtractionConfig(
            try_extract_without_anchor=False,
            boxed_match_priority=0,
            normalization_config=NormalizationConfig(
                basic_latex=True,
                units=True,
                malformed_operators=False,
                nits=False,
                boxed="all",
                equations=False,
            ),
        )
        return config, parse, (Basic, MatrixBase), srepr

    def _records(self, questions, captures, seen, deadline):
        _check_deadline(deadline)
        require(
            questions and set(questions) == set(captures),
            "diagevo-classifier-coverage",
            "question texts and captures must match",
        )
        config, parse, types, srepr = self._backend()
        result = {}
        for key in sorted(questions):
            require(
                isinstance(questions[key], str)
                and questions[key].strip()
                and 0 < len(captures[key]) <= self.parameters["max_responses_per_question"],
                "diagevo-classifier-coverage",
                "each question requires a bounded nonempty response group",
            )
            rows = []
            for raw in captures[key]:
                _check_deadline(deadline)
                _, _, identity, body, text = _capture(self.store, raw, seen)
                require(
                    body["messages"][-1]["content"] == questions[key]
                    and len(text) <= self.parameters["max_response_characters"],
                    "diagevo-classifier-input",
                    "classifier requires the exact question and bounded captured response",
                )
                boxed, status = _last_box(text)
                parsed = (
                    parse(
                        boxed,
                        extraction_config=[config],
                        fallback_mode="no_fallback",
                        extraction_mode="first_match",
                        parsing_timeout=self.parameters["timeout_seconds"],
                        raise_on_error=True,
                    )
                    if boxed is not None
                    else []
                )
                _check_deadline(deadline)
                value = parsed[0] if len(parsed) == 1 and isinstance(parsed[0], types) else None
                if boxed is not None:
                    status = "parsed" if value is not None else "unsupported_answer"
                rows.append(
                    {
                        "raw": asdict(raw),
                        "trajectoryDigest": identity,
                        "box": boxed,
                        "status": status,
                        "expression": srepr(value) if value is not None else None,
                        "value": value,
                    }
                )
            result[key] = sorted(rows, key=lambda row: row["trajectoryDigest"])
        return result

    def _same(self, left, right, deadline):
        _check_deadline(deadline)
        if left is None or right is None:
            return False, False
        from math_verify import verify

        options = dict(
            float_rounding=self.parameters["float_rounding"],
            numeric_precision=self.parameters["numeric_precision"],
            strict=True,
            allow_set_relation_comp=True,
            timeout_seconds=self.parameters["timeout_seconds"],
            raise_on_error=True,
        )
        forward = bool(verify(left, right, **options))
        _check_deadline(deadline)
        reverse = bool(verify(right, left, **options))
        _check_deadline(deadline)
        return forward, reverse

    def _proof(
        self, question, rows, comparisons, labels, *, curriculum_ref=None, construction_ref=None
    ):
        return self.store.put_json(
            {
                "schemaVersion": 1,
                "kind": "diagevo-math-comparisons",
                "classifier": self.identity(),
                "question": question,
                "captures": [
                    {key: value for key, value in row.items() if key != "value"} for row in rows
                ],
                "comparisons": comparisons,
                "labels": labels,
                "curriculumRef": curriculum_ref,
                "constructionClassesRef": construction_ref,
            }
        )

    def _seal(self, labels, *, curriculum_ref=None):
        return self.store.put_json(
            {
                "schemaVersion": 1,
                "kind": "diagevo-answer-classes"
                if curriculum_ref is None
                else "diagevo-optimization-classes",
                "classifier": self.identity(),
                "labels": labels,
                **({"curriculumRef": curriculum_ref} if curriculum_ref is not None else {}),
            }
        )

    def _construction(self, questions, captures, deadline):
        seen = set()
        records = self._records(questions, captures, seen, deadline)
        all_labels, by_capture = [], {}
        for question_id, rows in records.items():
            parents = list(range(len(rows)))

            def root(index):
                while parents[index] != index:
                    index = parents[index]
                return index

            comparisons, equal = [], {}
            for i, row in enumerate(rows):
                if row["value"] is not None:
                    require(
                        all(self._same(row["value"], row["value"], deadline)),
                        "diagevo-inconsistent-equivalence",
                        "a parsed answer must agree with itself",
                    )
                for j in range(i):
                    directions = self._same(rows[j]["value"], row["value"], deadline)
                    comparisons.append(
                        {
                            "left": rows[j]["trajectoryDigest"],
                            "right": row["trajectoryDigest"],
                            "forward": directions[0],
                            "reverse": directions[1],
                        }
                    )
                    equal[j, i] = all(directions)
                    if equal[j, i]:
                        parents[root(i)] = root(j)
            require(
                all(agrees == (root(i) == root(j)) for (i, j), agrees in equal.items()),
                "diagevo-inconsistent-equivalence",
                "answer comparisons are not a transitive partition",
            )
            labels = []
            for i, row in enumerate(rows):
                members = [
                    other["trajectoryDigest"] for j, other in enumerate(rows) if root(j) == root(i)
                ]
                answer = (
                    "answer/" + digest_json([question_id, members])
                    if row["value"] is not None
                    else "unparsed/" + row["trajectoryDigest"]
                )
                by_capture[row["trajectoryDigest"]] = answer
                labels.append({"trajectoryDigest": row["trajectoryDigest"], "answerKey": answer})
            proof = self._proof(questions[question_id], rows, comparisons, labels)
            all_labels.extend({**row, "evidenceRef": proof} for row in labels)
        _check_deadline(deadline)
        return self._seal(all_labels), records, by_capture, seen

    def construction(self, questions, captures):
        """Classify complete captured responses; the policy enforces N and filtering."""
        return self._construction(
            questions, captures, time.monotonic() + self.parameters["max_seconds"]
        )[0]

    def optimization(self, curriculum_ref, groups):
        """Preserve construction class IDs; never renumber them from fresh answers."""
        deadline = time.monotonic() + self.parameters["max_seconds"]
        pool = self.store.read_json(curriculum_ref)
        require(
            pool.get("kind") == "diagevo-solver-curriculum"
            and pool.get("schemaVersion") == 1
            and pool.get("classifier") == self.identity(),
            "diagevo-classifier-drift",
            "optimization requires this frozen mathematical classifier",
        )
        inputs = pool["input"]
        reference_ref, references, classes, seen = self._construction(
            inputs["questions"],
            {
                key: [RawTrajectory(**row) for row in rows]
                for key, rows in inputs["construction"].items()
            },
            deadline,
        )
        require(
            reference_ref == inputs["answerClassesRef"],
            "diagevo-classifier-drift",
            "construction classes must reproduce under the frozen classifier",
        )
        retained = {row["question_id"] for row in pool["votes"] if row["retained"]}
        captures = {}
        for group in groups:
            for raw in group:
                key = self.store.read_json(raw.context_ref)["taskId"]
                require(
                    key in retained,
                    "diagevo-unretained-question",
                    "optimization needs a retained question",
                )
                captures.setdefault(key, []).append(raw)
        require(captures, "diagevo-classifier-coverage", "optimization needs captured responses")
        records = self._records(
            {key: inputs["questions"][key] for key in captures}, captures, seen, deadline
        )
        all_labels = []
        for question_id, rows in records.items():
            comparisons, labels = [], []
            for row in rows:
                by_class = {}
                for reference in references[question_id]:
                    if reference["value"] is None:
                        continue
                    directions = self._same(reference["value"], row["value"], deadline)
                    comparisons.append(
                        {
                            "left": reference["trajectoryDigest"],
                            "right": row["trajectoryDigest"],
                            "forward": directions[0],
                            "reverse": directions[1],
                        }
                    )
                    by_class.setdefault(classes[reference["trajectoryDigest"]], []).append(
                        all(directions)
                    )
                require(
                    all(all(values) or not any(values) for values in by_class.values()),
                    "diagevo-inconsistent-equivalence",
                    "optimization matches only part of a construction class",
                )
                matched = [key for key, values in by_class.items() if all(values)]
                require(
                    len(matched) <= 1,
                    "diagevo-inconsistent-equivalence",
                    "optimization matches incompatible construction classes",
                )
                answer = matched[0] if matched else "unmatched/" + row["trajectoryDigest"]
                labels.append({"trajectoryDigest": row["trajectoryDigest"], "answerKey": answer})
            proof = self._proof(
                inputs["questions"][question_id],
                rows,
                comparisons,
                labels,
                curriculum_ref=curriculum_ref,
                construction_ref=reference_ref,
            )
            all_labels.extend({**row, "evidenceRef": proof} for row in labels)
        _check_deadline(deadline)
        return self._seal(all_labels, curriculum_ref=curriculum_ref)
