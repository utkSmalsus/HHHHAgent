# Eval V2 — permanent regression benchmark

**Version:** v2.0 (see `dataset.json`/`ground_truth.json` `version` field)

## Why this exists

The original ~100-question benchmark used across Phases 8–13 was never committed to version
control and was permanently lost to a scratchpad/session reset. This benchmark is committed to
git specifically so that can't happen again — it survives session resets, machine changes, and
future agents working on this repo.

## Files

- `dataset.json` — the 185 questions (id, category, difficulty, question text, tags). No expected
  answers here on purpose, so the harness can't "cheat" by reading them while asking.
- `ground_truth.json` — expected facts/behavior per question ID, computed **independently** from
  raw `enterprise_knowledge` Qdrant payloads (via the app's own verified, unit-tested business-logic
  functions — `taskIsOverdue`, `descendantContainerIds`, `uniqueBusinessEntities` — never from the
  live agent's own answers).
- `run-eval-v2.mjs` — sends every question to the live agent (`POST /api/query`) and records raw
  answers. Multi-turn conversations are sent turn-by-turn with real prior-turn history, never with
  a pre-expanded follow-up question.
- `scorer.mjs` — automated deterministic scoring (counts, dates, exact facts, list membership,
  NOT_FOUND/AMBIGUOUS/UNSUPPORTED/CLARIFY behavior detection). Anything requiring free-text semantic
  judgment is marked `REVIEW_REQUIRED` rather than auto-graded by a heuristic pretending to be
  reliable, or by the same production LLM being evaluated.
- `QUESTION_REPORT.md` — full human-readable inventory of every question, its category/difficulty,
  expected behavior summary, and the real entities used.
- `results/baseline.json` — raw agent answers from the frozen baseline run.
- `results/scored-auto.json` — automated scorer output.
- `results/baseline-summary.json` — final scores (automated + manual review merged), category/
  difficulty breakdowns, safety metrics.
- `results/baseline-failures.json` — ranked failure report.

## Regenerating the dataset

`../../scripts/build-eval-v2.mjs` builds `dataset.json`/`ground_truth.json` from live production
data. **Do not re-run it to "fix" a failing baseline** — that would silently change ground truth to
match whatever the agent currently does, defeating the point of a frozen benchmark. Only re-run it
deliberately, with an explicit version bump (v2.0 → v2.1 or v3.0), when the underlying production
data has materially changed (e.g. new projects/people) or a real dataset defect is found.

## Running a new baseline (e.g. after a future RAG/agent change)

```bash
node eval/v2/run-eval-v2.mjs --out eval/v2/results/<label>.json
node eval/v2/scorer.mjs --results eval/v2/results/<label>.json
```

Then compare `<label>` against `baseline.json` the same way prior phases compared before/after —
by category, by difficulty, and especially by the safety metrics (CONFIDENT_WRONG_ANSWER,
CONFIDENT_WRONG_ENTITY, HALLUCINATION, UNSAFE_GLOBAL_FALLBACK), not just raw PASS%.

## Freezing rule

Once a baseline is recorded, do not edit `dataset.json`/`ground_truth.json` to make a failing
question pass. Any real correction to a question or its expected answer requires bumping
`EVAL_VERSION` in `scripts/build-eval-v2.mjs` and documenting why in this README's changelog below.

## Changelog

- **v2.0** (this baseline) — initial creation, 185 questions, 11 categories, real production
  entities as of the data-mining run recorded in `dataset.json`'s `generatedAt` field.
