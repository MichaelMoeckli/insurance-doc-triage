# claim-triage

[![CI](https://github.com/MichaelMoeckli/insurance-doc-triage/actions/workflows/ci.yml/badge.svg)](https://github.com/MichaelMoeckli/insurance-doc-triage/actions/workflows/ci.yml)

Structured extraction and triage of unstructured Swiss insurance documents, using OpenAI
Structured Outputs — with an eval harness that makes prompt changes measurable instead of
anecdotal.

25 synthetic documents. Two model calls per document. One report.

## At a glance

|  |  |
| --- | --- |
| **The task** | A claim notification arrives as free text in German or English. Pull out the policy number, claimant, date of loss and amount; flag what the document *fails* to say; decide how fast a human must pick it up. |
| **Headline** | **97.3%** field accuracy (146/150), **100%** urgency accuracy with zero under-triage, and **97.7%** of the model's own source quotes verified against the document — on `gpt-5-mini`, at ~$0.002 and ~10 s per document. |
| **The finding** | That 97.3% is one draw from a distribution. **Three runs of the identical configuration scored 149, 147 and 146 of 150** — a 2pp spread with nothing changed between them. Urgency was 25/25 with zero under-triage in all three. The metric the recommendation rests on is the one that replicates. |
| **Model choice** | **The frontier model is the wrong buy.** `gpt-5` costs 6.4× more, ties on extraction, and produced this project's only under-triage on a capable model. `gpt-4.1-mini` is half the price and under-triages two injuries and a legal deadline. |
| **Stack** | TypeScript, OpenAI Responses API with strict Structured Outputs, hand-written JSON Schemas, a versioned prompt registry, and a one-page Next.js demo over the same pipeline. |
| **Check it in 30 seconds** | `npm install && npm run eval:validate` — validates all 25 document/label pairs. No API key, no model calls, no spend. |

**The detail lives in three documents:**
[**Evaluation**](docs/evaluation.md) — what the runs showed, the replicate, the model
comparison, the failure taxonomy ·
[**Deployment**](docs/deployment.md) — discovery questions, privacy, human-in-the-loop
routing, monitoring ·
[**Running it**](docs/running.md) — every entry point, flags, configuration

![The demo page: a German claim email in, extraction with source quotes, completeness flags, triage and per-call cost out.](docs/screenshot.png)

<sub>`npm run web` — the same `runPipeline` the CLI and the eval harness call, with per-call
tokens, cost and latency.</sub>

---

## Problem

A Swiss composite insurer receives claim notifications as unstructured text: customer
emails in German and English, transcribed paper claim forms, broker notes, adjuster
memos, hospital invoice cover letters, phone-call notes. Before anything else can happen,
a human reads each one and does three small things: pulls out the policy number, the
claimant, the date of loss and the amount; notices what the document *fails* to say, so
the missing information can be requested in the first reply rather than the fourth; and
decides how fast it needs to be picked up.

That work is high-volume, low-judgement, and it is the bottleneck in front of everything
downstream. It is also where the cost sits: a claim that waits in a queue because nobody
noticed the water was still running is more expensive than the same claim handled on the
day it arrived, and a claim that bounces back and forth for three weeks because the first
reply asked for the wrong missing field is expensive in handler time.

This repository is the narrow first slice of that: **extract, flag what's missing,
triage** — with the measurement built in from the start.

## Approach

**Scope one narrow, high-value task and make it measurable before making it bigger.**

The temptation with a document pipeline is to build the whole thing — ingestion, OCR,
retrieval over policy wordings, a review UI — and then discover at the end that field
accuracy is 71% and nobody knows which part is responsible. So the order here is
deliberately inverted:

1. **Pick the narrowest task with real value.** Extraction plus triage on plain text. No
   OCR, no retrieval, no workflow integration. If this does not work, nothing built on
   top of it works either.
2. **Constrain the output before prompting for it.** Every model call uses Structured
   Outputs with a hand-written strict JSON Schema, so "the model returned prose instead
   of JSON" is not one of the failure modes that has to be handled, and the closed enums
   make classification measurable at all.
3. **Build the eval harness second, not last.** 25 labelled documents, a failure
   taxonomy, and a versioned prompt registry. The harness existed before the prompt was
   tuned, which is the only ordering that lets you claim a change was an improvement.
4. **Use the model only where a model is needed.** Completeness checking is a loop over a
   constant, not a third API call. Quote grounding is a substring search. The one-line
   summary is built with string concatenation, not generated. Each decision removes
   latency, cost and a failure mode.
5. **Make the model show its work, then check it.** Every filled field must come with the
   verbatim span it was taken from, and every span is matched back against the document.
   That check needs no model and no label, so unlike accuracy it still works on the
   documents a deployment actually sees.

Four explicit rules make the numbers mean something:

- **The ambiguity rule.** If a field cannot be resolved to a single unambiguous value, it
  is `null` *and* its name goes in `missingFields`. "Letzten Dienstag" and "March 2025"
  are not dates. This is stated in the prompt, enforced in the ground-truth labels by the
  dataset validator, and enforced again at scoring time — `normalizeDate` refuses to
  rescue a month-only value.
- **The urgency rubric** (below) is fixed text, mirrored between the prompt and the
  labelling. If the rubric and the labels can drift, urgency accuracy measures nothing.
- **Strict and normalised accuracy are both reported.** Normalising away a date written
  with dots is fair. Silently hiding that it happened is not.
- **Evidence is checked, not assumed.** `sourceQuotes` would be decoration if nothing
  verified it, so `src/pipeline/grounding.ts` matches every cited span against the source
  and the eval reports a grounding rate beside accuracy. The two are kept apart on
  purpose: a value can be right with a fabricated citation, or wrong with a real one.

## The synthetic dataset

25 documents in `data/docs/`, each with a hand-authored label in `data/labels/`. The
distribution *is* the test design — the set is built to break the pipeline in specific,
diagnosable ways rather than to look representative:

| Dimension | Mix |
| --- | --- |
| Line of business | motor 7, property 7, health 6, liability 5 |
| Language | German 11, English 11, mixed 3 — a `language` field on every label, so results can be [sliced by it](docs/evaluation.md#by-language) |
| Format | emails, transcribed claim forms, broker notes, adjuster memos, a hospital invoice cover letter, a phone-call note, a lawyer's letter |
| Completeness | 13 complete, 12 with at least one unresolvable required field |
| Unresolvable dates | 5 — relative (`letzten Dienstag`), month-only (`im März 2025`, `Anfang Juni`), and format-ambiguous (`03/04/2025`, `06/07/2025`) |
| Number/currency traps | Swiss apostrophe (`12'450.00`), German decimal comma (`8.500,00`), rappen dash (`Fr. 3'200.—`), a euro amount on a Swiss policy, an amount with no currency stated |
| Urgency | high 7, normal 13, low 5 |
| Identifier distractors | claim references, invoice numbers, police report numbers, a law-firm file reference |
| Name distractors | brokers, adjusters, lawyers, an injured third party, and an HR contact sharing a surname with the injured employee |

Each label carries a `notes` line explaining *why* that document is hard. Notes are not
scored — they are printed in the failure log, which turns it from a diff dump into
something readable. `language` is not scored either; it is hand-assigned rather than
detected, because detecting it would put a second fallible component inside the
measurement.

## Architecture

```
data/docs/*.txt                                       data/labels/*.json
   (unstructured document)                              (ground truth)
        |                                                     |
        v                                                     |
  +-----------------+                                         |
  | 1. EXTRACT      |  OpenAI Responses API                   |
  |    model call   |  strict JSON Schema: extraction_result  |
  +-----------------+                                         |
        |  policyNumber, claimantName, dateOfLoss,            |
        |  claimType, amount, currency, missingFields         |
        v                                                     |
  +-----------------+                                         |
  | 2. COMPLETENESS |  deterministic - no model call          |
  |    + GROUNDING  |  required fields + agreement check;     |
  |    plain TS     |  every sourceQuote matched to the text  |
  +-----------------+                                         |
        |  missing[], isComplete, disagreements[],            |
        |  ungrounded[], uncited[]                            |
        v                                                     |
  +-----------------+                                         |
  | 3. TRIAGE       |  OpenAI Responses API                   |
  |    model call   |  strict JSON Schema: triage_result      |
  +-----------------+                                         |
        |  urgency, category, recommendedAction               |
        v                                                     |
  +-----------------+                                         |
  | 4. OUTPUT       |  JSON + one-line summary (built in TS)  |
  +-----------------+                                         |
        |                                                     |
        +--------------------> [ EVAL ] <---------------------+
                                  |
              results.md + results/run-<version>--<model>.json
```

Triage is a second call rather than a bigger schema on the first one. It costs roughly
double, and buys two things: triage reasons over *validated* fields and the completeness
flags instead of re-deriving them from raw text, and — more importantly — the eval can
tell an extraction error apart from a classification error. In a combined call, a
misparsed amount that drags urgency down the rubric shows up as two failures with one
cause, and the failure log stops pointing at the fix.

### Layout

```
src/
  schema.ts             strict JSON Schemas + runtime validators
  types.ts              domain types and closed vocabularies
  config.ts             env, paths, indicative pricing
  openai/client.ts      Responses API wrapper, model-aware parameters
  prompts/              versioned prompt registry (v1, v2)
  pipeline/             extract -> completeness + grounding -> triage -> summary
  eval/                 dataset loading, normalization, scoring, taxonomy, report
  cli/                  extract.ts (one document), eval.ts (the whole set), report.ts
app/                    one-page Next.js demo; a thin shell over the same pipeline
data/docs/              25 synthetic documents
data/labels/            25 ground-truth labels
results/                run records, one per (prompt version, model), committed -
                        they drive the comparison table
```

## How to run

Requires Node 20.11+ and an OpenAI API key. Full detail — every flag, the `npm run`
argument quirk, the browser demo and the configuration surface — is in
[**docs/running.md**](docs/running.md).

```bash
npm install && cp .env.example .env
```

Add your key to `.env`, then:

```bash
npm run eval
```

Worth running first, because it needs no key and spends nothing:

```bash
npm run eval:validate
```

Unit tests for the normalization, scoring and grounding logic — the harness decides what
counts as correct, so it gets tested:

```bash
npm test
```

## The urgency rubric

Mirrored verbatim in `src/prompts/v1.ts` and used to author every label.

- **high** — any of: a person was injured; damage is ongoing or the property is unsafe;
  a third party has set a legal or regulatory deadline; the claimed amount is CHF 50,000
  or more.
- **low** — all of: no injury, no ongoing damage, no deadline, and either the claimed
  amount is under CHF 1,000 or the document is purely administrative.
- **normal** — everything else.

`high` beats `low` when both apply. Missing fields do not raise urgency; they go in
`recommendedAction`.

In a real deployment these thresholds are the customer's to set, and the first discovery
session would replace them. They are written down here so that "urgency accuracy: 84%" is
a statement about something.

## Results

`gpt-5-mini`, 25 documents, 50 calls, ~$0.05 per run. Generated tables, the failure log
and the version comparison are in [`results.md`](results.md); the reading of them is in
[**docs/evaluation.md**](docs/evaluation.md).

| Metric | v1 | v2 (committed) | v2 (two earlier replicates) |
| --- | --- | --- | --- |
| Field accuracy (normalised) | 98.0% | 97.3% | 99.3%, 98.0% |
| `missingFields` exact set match | 92.0% | 96.0% | 100.0%, 92.0% |
| Category accuracy | 100.0% | 96.0% | 96.0%, 100.0% |
| Grounded source quotes | — | 97.7% | —, 96.2% |
| **Urgency accuracy** | **100.0%** | **100.0%** | **100.0%, 100.0%** |
| **— of which under-triaged** | **0** | **0** | **0, 0** |

**The third column is the point.** `v2` on `gpt-5-mini` has been run three times with
nothing changed between runs — same prompt text, same schemas, same documents, same model.
Field accuracy spans 2pp across those runs. Every extraction metric moves by one to three
documents for no reason at all; the third run even produced two failure categories no run
had ever shown. **Urgency did not move once.**

Two things follow. The v1 → v2 comparison **cannot be read**: the prompt change is smaller
than the noise, and the honest statement is not "better" or "worse" but *this dataset
cannot tell*. And the [model recommendation](docs/evaluation.md#what-the-model-comparison-found)
must rest on the columns that survive replication — under-triage and cost — which is where
it already rested, for the same reason, before the replicate proved the point.

The one attributable finding from v2 is a **data-modelling** problem, not a prompt one: the
changed string fixed `liability-22` and broke `health-20`, because on a liability claim the
useful name is the insured and on a workplace accident it is the injured employee. One
field cannot be both. [The full analysis is the deliverable, not the number.](docs/evaluation.md)

### What quote grounding caught

97.7% of cited spans (128/131) matched the source, every filled field carried a span, and
no span was attached to a null field. Three spans failed — and **none is a hallucination**.
Two are ellipsis elisions, one is a rejoined hyphenated line break. That is a *contract*
defect: the schema says "verbatim span" and "at most about 100 characters" but never says
*contiguous, unabridged*. It is a clean one-string v3 candidate, and the only prompt
experiment on this repo with a target larger than the noise floor.

## Scope note — what this is not

A weekend-sized portfolio piece. The omissions are deliberate:

- **Synthetic data, 25 documents.** For [privacy reasons](docs/deployment.md#data-privacy),
  and because hand-authoring labels forced every ambiguous case to be decided explicitly.
  Enough to find systematic failure modes; *not* enough for a confident accuracy claim —
  the replicate puts that at 2pp. A real deployment needs a few hundred labels from the
  real mix.
- **One run per (prompt version, model).** A second run of the same configuration
  overwrites the first, so the replicate table above had to be assembled by hand from
  records read out before they were replaced. Recording replicates means a run id and a
  reported band instead of a point; it is the first change I would make to this harness.
- **No RAG, no embeddings, no vector store.** Nothing in this task requires retrieval. The
  document contains the facts, and the categories are a fixed vocabulary that fits in the
  prompt. Coverage checking against real policy wordings would need retrieval — a
  different, later task.
- **No ingestion beyond paste and `.txt`.** Scanned PDFs are the obvious next step, and
  would move every number in `results.md`, because OCR noise is a different failure
  distribution. A pipeline not measured on clean text cannot be debugged on noisy text.
- **One page, no service.** `npm run web` is a single Next.js route so a reviewer can try
  the pipeline; no auth, no database, no rate limiting. The interesting content is the
  schema design, the pipeline decomposition and the eval harness.
- **Two model calls per document, no caching, no batching.** Correct for 25 documents and
  wrong for 25,000. The Batch API and prompt caching are the obvious first optimisations
  and neither would change the results.
- **Prices in `src/config.ts` are hard-coded and will go stale.** Cost is computed when the
  report is rendered, not stored in a run record, so a stale price is a wrong line in a
  regenerable file rather than a wrong number frozen in the history.

The eval harness is the part that would survive contact with a real deployment. The rest
is scaffolding around it.

## Licence

MIT — see [LICENSE](LICENSE).
