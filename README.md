# claim-triage

Structured extraction and triage of unstructured Swiss insurance and finance documents,
using OpenAI Structured Outputs — with an eval harness that makes prompt changes
measurable instead of anecdotal.

25 synthetic documents. Two model calls per document. One report.

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
   constant, not a third API call. The one-line summary is built with string
   concatenation, not generated. Both decisions remove latency, cost and a failure mode.

Three explicit rules make the numbers mean something:

- **The ambiguity rule.** If a field cannot be resolved to a single unambiguous value, it
  is `null` *and* its name goes in `missingFields`. "Letzten Dienstag" and "March 2025"
  are not dates. This is stated in the prompt, enforced in the ground-truth labels by the
  dataset validator, and enforced again at scoring time — `normalizeDate` refuses to
  rescue a month-only value.
- **The urgency rubric** (below) is fixed text, mirrored between the prompt and the
  labelling. If the rubric and the labels can drift, urgency accuracy measures nothing.
- **Strict and normalised accuracy are both reported.** Normalising away a date written
  with dots is fair. Silently hiding that it happened is not.

## The synthetic dataset

25 documents in `data/docs/`, each with a hand-authored label in `data/labels/`. The
distribution *is* the test design — the set is built to break the pipeline in specific,
diagnosable ways rather than to look representative:

| Dimension | Mix |
| --- | --- |
| Line of business | motor 7, property 7, health 6, liability 5 |
| Language | German 11, English 11, mixed German/English 3 |
| Format | emails, transcribed claim forms, broker notes, adjuster memos, a hospital invoice cover letter, a phone-call note, a lawyer's letter |
| Completeness | 13 complete, 12 with at least one unresolvable required field |
| Unresolvable dates | 5 — relative (`letzten Dienstag`), month-only (`im März 2025`, `Anfang Juni`), and format-ambiguous (`03/04/2025`, `06/07/2025`) |
| Number/currency traps | Swiss apostrophe (`12'450.00`), German decimal comma (`8.500,00`), rappen dash (`Fr. 3'200.—`), a euro amount on a Swiss policy, an amount with no currency stated |
| Urgency | high 7, normal 13, low 5 |
| Identifier distractors | claim references, invoice numbers, police report numbers, a law-firm file reference |
| Name distractors | brokers, adjusters, lawyers, an injured third party, and an HR contact sharing a surname with the injured employee |

Each label carries a `notes` line explaining *why* that document is hard. Those notes are
not scored — they are printed in the failure log, which turns it from a diff dump into
something readable.

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
  |    plain TS     |  required fields + agreement check      |
  +-----------------+                                         |
        |  missing[], isComplete, disagreements[]             |
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
                    results.md + results/run-<version>.json
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
  prompts/              versioned prompt registry (v1, + your v2)
  pipeline/             extract -> completeness -> triage -> summary
  eval/                 dataset loading, normalization, scoring, taxonomy, report
  cli/                  extract.ts (one document), eval.ts (the whole set)
data/docs/              25 synthetic documents
data/labels/            25 ground-truth labels
results/                run records, committed - they drive the comparison table
```

## How to run

Requires Node 20.11+ and an OpenAI API key.

```bash
npm install
```

```bash
cp .env.example .env
```

Add your key to `.env`, then:

```bash
npm run eval
```

Other entry points:

```bash
npm run eval:validate
```

Checks all 25 document/label pairs offline — pairing, enums, and the ambiguity rule — with
no API calls and no spend. Worth running first.

```bash
npm run eval:smoke
```

The first 5 documents only, as a cheap check that the key and model work.

```bash
npm run extract -- data/docs/motor-04-highway-injury.txt
```

One document, printing the summary line and the full JSON.

```bash
npx tsx src/cli/eval.ts --doc motor-04 --concurrency 8
```

Any other flag combination. `--doc` matches on an id substring; `npx tsx src/cli/eval.ts --help`
lists the rest.

> **On flags and `npm run`.** `npm run eval -- --limit 5` does not work: npm treats a
> `--flag` after the `--` separator as one of its own config keys and forwards only the
> value, so the script receives a bare `5`. It bites on Windows and PowerShell in
> particular. Positional arguments survive — which is why `npm run extract -- <path>` is
> fine — but flags need `npx tsx`, or one of the `eval:*` scripts above. The eval CLI
> detects the mangled form and says so rather than just rejecting the argument.

```bash
npm test
```

Unit tests for the normalization and scoring logic, on Node's built-in test runner. The
harness decides what counts as correct, so it gets tested.

### Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `OPENAI_API_KEY` | — | Required, except for `--validate-only`. |
| `OPENAI_MODEL` | `gpt-5-mini` | Any Structured-Outputs-capable model. |
| `OPENAI_REASONING_EFFORT` | `low` | gpt-5 / o-series only. |
| `PROMPT_VERSION` | `v1` | Selects the prompt set. The knob for the eval loop. |

All four can be set in `.env`, which is the portable way to switch prompt versions on
Windows — `PROMPT_VERSION=v2 npm run eval` is POSIX shell syntax and will not work in
PowerShell.

`src/openai/client.ts` branches on the model id: gpt-5 and o-series models get
`reasoning.effort`, everything else gets `temperature: 0`. Switching `OPENAI_MODEL` to
`gpt-4.1-mini` works without touching code.

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

`gpt-5-mini`, 25 documents, 50 calls, ~42k in / ~19k out tokens, ~$0.05 per run.
Full tables, the failure log and the version comparison are in
[`results.md`](results.md); this is the summary.

| Metric | v1 | v2 |
| --- | --- | --- |
| Field accuracy (normalised) | 98.0% (147/150) | **99.3%** (149/150) |
| Field accuracy (strict) | 98.0% (147/150) | **98.7%** (148/150) |
| `policyNumber` | 100.0% (25/25) | 100.0% (25/25) |
| `claimantName` | 96.0% (24/25) | 96.0% (24/25) |
| `dateOfLoss` | 96.0% (24/25) | 100.0% (25/25) |
| `claimType` | 100.0% (25/25) | 100.0% (25/25) |
| `amount` | 96.0% (24/25) | 100.0% (25/25) |
| `currency` | 100.0% (25/25) | 100.0% (25/25) |
| `missingFields` exact set match | 92.0% (23/25) | 100.0% (25/25) |
| — precision / recall | 90.0% / 100.0% | 100.0% / 100.0% |
| Urgency accuracy | 100.0% (25/25) | 100.0% (25/25) |
| — of which under-triaged | 0 | 0 |
| Category accuracy | 100.0% (25/25) | 96.0% (24/25) |
| Hard failures | 5 | 2 |

**v2 change:** one string — the `claimantName` schema description. v1 called the field
*"the policyholder or claimant"*; v2 defines it as the policyholder explicitly. Both
instruction blocks, both input builders and every other field description are v1 verbatim
(`src/prompts/v2.ts` spreads `v1` rather than copying it, so the diff cannot drift).

**What it fixed / what it cost: net zero, and that is the finding.** Headline field
accuracy rose 1.3pp — and essentially none of that is attributable to the change. See
below.

### What v1 got wrong

Five hard failure records across three documents, two root causes — and the interesting
part is that strict and normalised accuracy are identical: **zero format failures**. No
misparsed Swiss apostrophes, no German decimal commas read as decimal points, no `EUR`
silently defaulted to `CHF`, no non-ISO dates. The traps the dataset was built around
were not the ones that fired.

What fired instead:

1. **Over-abstention (4 of the 5 records, on 2 documents).** The null-on-ambiguity rule
   over-triggers, and each over-abstention costs twice — once as `missed-field`, once as
   `spurious-missing-field`.
   - `motor-06`: "rund CHF 2'800.00" → `amount: null`. An approximate figure is still a
     figure; "rund" made the model discard it.
   - `property-08`: an email dated `3. Juli 2025` describing water escaping "seit heute
     Abend" → `dateOfLoss: null`. The letterhead date resolves it.

   The completeness numbers say the same thing precisely: **recall 100%, precision 90%**.
   The model never missed a field that was genuinely absent — it declared extra ones.
   Over-abstention is the safe direction to be wrong in. Both cases came back clean on
   the v2 run without anything being changed to address them, which is the first clue
   that this set is at the edge of what 25 documents can resolve.

2. **An ambiguous field definition — my bug, not the model's.** `liability-22` returned
   `Bertschi Logistik AG` where the label says `Stefan Hauser`. The v1 schema description
   reads *"policyholder or claimant"* — on a liability claim those are two different
   parties, and the model picked the other one. The instruction is self-contradictory and
   the model resolved it as reasonably as the wording allowed. This is what v2 targets.

3. **Classification is saturated.** Urgency and category are both 25/25, with zero
   under-triage. The explicit rubric appears to be doing its job — including the two
   cases designed to be hard for the wrong reasons: `property-09` (routine-sounding
   kitchen fire, `high` only because CHF 62,000 clears the threshold) and `property-12`
   (hail, correctly `other` rather than the tempting `property-water`). `property-12`
   flipped to `property-water` on the v2 run, which received a byte-identical triage
   prompt — so "saturated" here means "at the resolution this dataset can measure", not
   "solved".

### What v2 actually did

The one-string change had exactly the effect it was aimed at, and an equal and opposite
one nobody asked for:

- **Fixed** `liability-22`: `Bertschi Logistik AG` → `Mr Stefan Hauser`. Target hit.
  (Strict scoring still counts it as a miss because of the `Mr`; normalisation strips the
  title. That single cell is the whole 99.3% vs 98.7% gap.)
- **Broke** `health-20`: `Goran Petrović` → `Petrović Bau AG`. A UVG workplace-accident
  policy is held by the *employer*, so "the policyholder" is now correctly read as the
  company — and the injured employee, who is the name a handler actually needs, is gone.

`claimantName` therefore scored **96% before and 96% after**. One document traded for
another.

That is not a prompt problem. It is a **modelling** problem, and the eval surfaced it in
one run: on a liability claim the useful name is the insured, and on an accident claim it
is the injured party. One field cannot be both, and every wording that disambiguates it
for one line of business breaks the other. v1's vague *"policyholder or claimant"* got
`health-20` right and `liability-22` wrong; v2's precise wording does the reverse.

The real fix is two fields — `policyholderName` and `claimantName` — or a per-`claimType`
rule. In a customer engagement that is a discovery question ("when your handlers say
*claimant*, which party do they mean, and does the answer change by product?"), not
something to guess at in a prompt. It is deliberately **not** patched here: it would mean
changing the schema, the types, all 25 labels and the scoring code at once, and a version
that changes five things measures nothing.

### An honest caveat on these numbers

**Most of the v1 → v2 delta is noise, and the run proves it.** Same prompt text, same
inputs, one changed string in one field description — yet four metrics moved that the
change cannot touch:

| Moved | Attributable to the change? |
| --- | --- |
| `claimantName` 96% → 96% | **Yes.** One fix, one regression. |
| `dateOfLoss` 96% → 100% (`property-08`) | No. Over-abstention resolved itself between runs. |
| `amount` 96% → 100% (`motor-06`) | No. Same. |
| `missingFields` 92% → 100% | No. Follows the two above. |
| `category` 100% → 96% (`property-12`) | No. Triage received a byte-identical schema and prompt. |

So the headline "+1.3pp field accuracy" is real in the sense that it happened, and
worthless in the sense that it says nothing about the change. On 25 documents a single
flipped answer moves field accuracy by 0.67pp; sampling variance at this size swamps a
one-string edit. **The correct reading of this comparison is that v2 fixed its target,
introduced a regression, and left everything else to chance.**

This is why the report separates per-field accuracy and a per-document failure log from
the headline number. If `results.md` showed only the top-line figure, this would have
looked like a clean win and shipped as one.

The useful next move is therefore *not* more prompt tuning against this set. It is to
resolve the `claimantName` modelling question, and to grow the dataset around the failure
mode the runs actually exposed — borderline abstention calls, and multi-party documents
where several names compete. A real deployment's first eval produces a better eval set
before it produces a better prompt.

### The prompt-version loop

`v1` is the honest first attempt: written before a single eval had been run, and not
pre-tuned against the dataset. `v2` is what came out of reading v1's failure log. Adding
a `v3`:

1. Run `npm run eval`, then read the **failure taxonomy** in `results.md`. Pick the
   category with the most hard failures.
2. `cp src/prompts/v2.ts src/prompts/v3.ts`, rename the export, set `version: 'v3'`, and
   write a `changelog` line naming the failure category you are targeting.
3. Make **one** change. Register it in `src/prompts/index.ts`, set `PROMPT_VERSION=v3` in
   `.env`, and run `npm run eval` again.

A version owns both its instruction text **and** its schemas, because the JSON Schema
field `description`s are prompt text — they are sent on every request and the model
follows them. `v2` differs from `v1` by exactly one description string, and it inherits
the rest by spreading `v1` rather than copying it, so the two cannot drift apart. Editing
a shared schema in place would silently change what every earlier version had been
measured on, which would make the comparison table a lie rather than a record.

Each run writes `results/run-<version>.json`, and the report renders every run record it
finds side by side with per-metric deltas — so the comparison table fills itself in.

Two cautions the v1 → v2 run earned the hard way. Changing more than one thing per
version makes the delta unattributable, which is why the recipe insists on one. And a
delta smaller than a couple of documents is not evidence of anything at this dataset
size — check the per-field rows and the failure log before believing a headline
improvement.

## Failure analysis

Across both runs only four of these categories ever fired — `missed-field` (2),
`spurious-missing-field` (2) and `name-mismatch` (1) on v1; `name-mismatch` (1) and
`category-mismatch` (1) on v2. The taxonomy in `src/eval/taxonomy.ts` is built so that
each category maps to a different *action*, not just a different symptom, which is what
let five v1 records resolve to two causes — and what made the v2 regression legible as a
regression rather than as a slightly different number:

| Category | What it implies |
| --- | --- |
| `date-format`, `amount-format` | Output-contract drift. Schema description or prompt fix. Counted separately as *soft* failures — the value normalises correctly, but any downstream consumer parsing raw output still breaks. |
| `date-value`, `amount-value` | Comprehension failure. Usually a report date taken for a loss date, or a deductible taken for a claimed amount. Prompt or few-shot fix. |
| `hallucinated-field` vs `missed-field` | Opposite calibration errors, fixed by opposite changes. Collapsing them into "wrong" throws away the only thing that tells you which way to push. |
| `missed-missing-field`, `spurious-missing-field` | The model's self-knowledge. This is the metric that decides whether the completeness output can be trusted to drive an automated reply. |
| `name-mismatch`, `policy-number-mismatch` | Distractor sensitivity — brokers, adjusters, lawyers, injured third parties, claim and invoice numbers. The dataset seeds all of these deliberately. |
| `urgency-mismatch` | Rubric fit. **Under-triage is tracked separately** because it is the only one of the two directions that costs the carrier money. |
| `category-mismatch` | Vocabulary fit. A cluster here usually means the taxonomy is wrong, not the model. |
| `schema-error`, `api-error` | Infrastructure. Errored documents stay in the denominator; dropping them would inflate accuracy exactly when the system is least reliable. |

### What I'd send back to product and research

- **Under-triage rate, not urgency accuracy.** A single classification number averages
  together an error that costs handler time and an error that costs claim reserve. Any
  triage product needs asymmetric evaluation, and probably asymmetric decision
  thresholds, as a first-class feature rather than something each deployment rebuilds.
- **Abstention is a capability, and it needs measuring.** The hardest thing to get right
  here is not extraction, it is getting the model to return `null` on an ambiguous date
  instead of a plausible one. `missingFields` precision and recall exist to measure
  exactly that. Calibrated abstention on structured extraction would be worth more to
  this class of deployment than a general accuracy improvement.
- **Locale handling is a recurring, unglamorous tax.** `12'450.00`, `8.500,00`,
  `Fr. 3'200.—`, `03/04/2025`. Every European deployment writes the same normalization
  code and the same prompt paragraph. Worth handling in the schema layer rather than
  leaving to every integrator.
- **Strict-mode schema authoring has sharp edges** — nullable-as-union, every property
  required, `additionalProperties: false` everywhere. Fine once learned, but it is the
  step where an FDE loses an afternoon on a first deployment.

## What I'd do next in a real deployment

**Discovery questions, before writing more code**

- What is the actual decision this output feeds? A routing queue, an auto-acknowledgement
  email, a reserve estimate? The required accuracy for "put it in the right queue" and
  "quote a figure to a customer" differ by an order of magnitude.
- What does the current process cost, in handler-minutes per document and in rework from
  incomplete first replies? Without that, there is no baseline and no way to size value.
- Who owns the urgency thresholds, and are they written down anywhere today? The rubric
  in this repo is a placeholder for a real one, and getting it from the claims operations
  lead is a half-day conversation, not an assumption.
- What is the real document mix — languages, formats, share arriving as scanned PDF
  rather than text? Everything here assumes text in; OCR quality would move every number.
- What happens today when a required field is missing? The value of the completeness
  output depends entirely on whether anyone acts on it.

**Data privacy**

Everything in `data/` is synthetic, and that is a deliberate choice rather than a
shortcut. Real claim documents contain names, addresses, policy numbers, medical
information and payment details — special-category personal data under the Swiss FADP and
the GDPR. Whether that data may leave the customer's environment, be sent to a model
provider, or be retained for evaluation is a question to *resolve during discovery with
the customer's DPO*, not to assume an answer to while building a prototype. Synthetic data
lets the pipeline, the schema and the eval harness be built and demonstrated in full
while that conversation happens in parallel. In a real engagement the next steps would be
zero-retention API terms, a documented data-residency position, PII redaction before any
eval artefact is persisted, and a labelled set built inside the customer's environment by
their own staff.

**Human-in-the-loop**

Nothing here should run unattended on day one. The design I would propose:

- Route on confidence, not on a single global accuracy number. Documents with an empty
  `missingFields`, no `disagreements`, and `normal`/`low` urgency are the automation
  candidates; everything else goes to a handler with the extraction pre-filled.
- Never auto-action a `high` urgency claim in either direction — those are the expensive
  ones in both the false-positive and false-negative directions.
- Make the handler's correction the training signal. A review UI that captures the
  corrected field is how the eval set grows past 25 documents into something
  representative, and it is the only sustainable source of labels.
- Start in shadow mode: run the pipeline alongside the human process for a few weeks and
  compare, before any output reaches a customer.

**Monitoring**

- Track the field-level metrics in production against a rolling human-reviewed sample,
  not just at deployment time. The document mix drifts; a new broker with a new template
  is a distribution shift.
- Alert on the *shape* of the output, not only errors: a sudden fall in the rate of
  declared `missingFields` usually means the model has started guessing, and it is
  visible long before anyone complains.
- Track under-triage rate and schema-error rate as separate SLOs, and pin the model
  version — a silent model upgrade is an unannounced change to a measured system.
- Keep `results.md` in the repository and regenerate it on every prompt change, so the
  performance history is reviewable in a diff.

## Scope note — what this is not

This is a weekend-sized portfolio piece. The omissions are deliberate:

- **Synthetic data (25 documents).** For the privacy reasons above, and because hand-authoring
  the labels forced every ambiguous case to be decided explicitly — which is where the
  ambiguity rule came from. 25 is enough to find systematic failure modes and to compare
  two prompt versions; it is *not* enough for a confident accuracy claim. At 25 documents
  a single flipped answer moves field accuracy by 0.7pp, so small deltas in the comparison
  table are noise. A real deployment needs a few hundred labels, drawn from the real mix.
- **No RAG, no embeddings, no vector store.** Nothing in this task requires retrieval. The
  document contains the facts to be extracted, and the categories are a fixed vocabulary
  that fits in the prompt. Adding a vector store would have added infrastructure, latency
  and a new failure mode to solve a problem that does not exist here. Coverage checking
  against actual policy wordings would need retrieval — that is a different, later task.
- **Local CLI only — no API, no database, no Docker.** The interesting content is the
  schema design, the pipeline decomposition and the eval harness. A web service around
  them would be more code and less signal.
- **Two model calls per document, no caching, no batching.** Correct for 25 documents and
  wrong for 25,000; the Batch API and prompt caching are the obvious first optimisations,
  and neither would change the results.
- **Prices in `src/config.ts` are hard-coded and will go stale.** They exist to print a
  rough spend figure per eval run, not to be authoritative.

The eval harness is the part that would survive contact with a real deployment. The rest
is scaffolding around it.
