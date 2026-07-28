# Evaluation: what the runs actually showed

Detailed analysis behind the headline in the [README](../README.md#results). The generated
numbers live in [`results.md`](../results.md), which every run overwrites; this file is the
reading of them.

## Results

`gpt-5-mini`, 25 documents, 50 calls, ~42k in / ~19k out tokens, ~$0.05 per run.
Full tables, the failure log and the version comparison are in
[`results.md`](../results.md); this is the summary.

| Metric | v1 | v2 (committed run) | v2 (two earlier replicates) |
| --- | --- | --- | --- |
| Field accuracy (normalised) | 98.0% (147/150) | 97.3% (146/150) | 99.3%, 98.0% |
| Field accuracy (strict) | 98.0% (147/150) | 96.7% (145/150) | 98.7%, 98.0% |
| `policyNumber` | 100.0% (25/25) | 96.0% (24/25) | 100.0%, 100.0% |
| `claimantName` | 96.0% (24/25) | 96.0% (24/25) | 96.0%, 96.0% |
| `dateOfLoss` | 96.0% (24/25) | 96.0% (24/25) | 100.0%, 96.0% |
| `claimType` | 100.0% (25/25) | 96.0% (24/25) | 100.0%, 100.0% |
| `amount` | 96.0% (24/25) | 100.0% (25/25) | 100.0%, 96.0% |
| `currency` | 100.0% (25/25) | 100.0% (25/25) | 100.0%, 100.0% |
| `missingFields` exact set match | 92.0% (23/25) | 96.0% (24/25) | 100.0%, 92.0% |
| — precision / recall | 90.0% / 100.0% | 94.7% / 100.0% | 100.0% / 100.0%, 90.0% / 100.0% |
| **Urgency accuracy** | **100.0% (25/25)** | **100.0% (25/25)** | **100.0%, 100.0%** |
| **— of which under-triaged** | **0** | **0** | **0, 0** |
| Category accuracy | 100.0% (25/25) | 96.0% (24/25) | 96.0%, 100.0% |
| Grounded source quotes | not yet measured | 97.7% (128/131) | —, 96.2% |
| Hard failures | 5 | 6 | 2, 5 |

The third column is the point of the table. Every extraction metric moves by one to three
documents across runs that differ in nothing at all; the two urgency rows do not move at
all. Read on.

**v2 change:** one string — the `claimantName` schema description. v1 called the field
*"the policyholder or claimant"*; v2 defines it as the policyholder explicitly. Both
instruction blocks, both input builders and every other field description are v1 verbatim
(`src/prompts/v2.ts` spreads `v1` rather than copying it, so the diff cannot drift).

**What it fixed / what it cost: net zero, and that is the finding.** v2 hit its target and
introduced an equal and opposite regression, leaving `claimantName` at 96% before and
after. Everything else that moved, in either direction, moved on its own. See below.

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
   Over-abstention is the safe direction to be wrong in. Both cases came back clean on the
   first v2 run without anything being changed to address them, which was the first clue
   that this set sits at the edge of what 25 documents can resolve —
   [and the replicate confirmed it](#the-replicate-that-settled-it): `property-08` failed
   again on the third run, `motor-06` did not. The failure mode is real and recurring; which
   documents it lands on is not.

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
   flipped to `property-water` on the first v2 run, which received a byte-identical triage
   prompt — so "saturated" here means "at the resolution this dataset can measure", not
   "solved". **Urgency is the exception, and it is the important one:** 25/25 with zero
   under-triage on v1 and on all three v2 runs. Category wobbles between runs; urgency has
   not moved once.

### What v2 actually did

The one-string change had exactly the effect it was aimed at, and an equal and opposite
one nobody asked for:

- **Fixed** `liability-22`: `Bertschi Logistik AG` → `Mr Stefan Hauser`. Target hit, and it
  has stayed hit on all three v2 runs. (Strict scoring still counts it as a miss because of
  the `Mr`; normalisation strips the title. That single cell is the entire strict-versus-
  normalised gap on the committed run — 145/150 against 146/150.)
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

### The replicate that settled it

The first version of this section argued from evidence that the v1 → v2 delta was mostly
noise: four metrics had moved that a one-string change to one field description cannot
touch. That was an inference. It is now a measurement.

`v2` on `gpt-5-mini` has been run **three times with nothing changed between runs** — same
prompt text, same schemas, same 25 documents, same model, same `reasoning.effort`. The
only thing that differed is what the model happened to emit.

| | Run 1 | Run 2 | Run 3 (committed) |
| --- | --- | --- | --- |
| Field accuracy (normalised) | 99.3% (149/150) | 98.0% (147/150) | 97.3% (146/150) |
| `policyNumber` | 25/25 | 25/25 | 24/25 |
| `dateOfLoss` | 25/25 | 24/25 | 24/25 |
| `claimType` | 25/25 | 25/25 | 24/25 |
| `amount` | 25/25 | 24/25 | 25/25 |
| `missingFields` exact | 25/25 | 23/25 | 24/25 |
| Category accuracy | 24/25 | 25/25 | 24/25 |
| Hard failures | 2 | 5 | 6 |
| **Urgency accuracy** | **25/25** | **25/25** | **25/25** |
| **Under-triaged** | **0** | **0** | **0** |

**Field accuracy has a 2pp spread across identical configurations.** Every extraction
metric in the table moves by one to three documents for no reason at all. Run 3 even
produced two failure categories no run had ever shown — a `claim-type-mismatch` and a
`policy-number-mismatch` (`Police CH-HH-2023-559012`, the German label word swept into the
value) — while Run 1's `category-mismatch` on `property-12` vanished in Run 2 and came back
in Run 3.

**And urgency does not move at all.** 25/25 with zero under-triage, three times. That is
the whole finding, and it is worth more than any single accuracy figure in this repository:
*the metric the recommendation rests on is the metric that replicates.* The
[model comparison](#what-the-model-comparison-found) already leaned on under-triage and
cost rather than on field accuracy, on the grounds that 25 documents cannot resolve a
2pp gap. Three replicates later, that gap is measured, and it is 2pp wide within a single
configuration.

Two consequences follow, and both are uncomfortable in the right way.

**The v1 → v2 comparison cannot be read at all.** v1 scored 147/150 and the three v2 runs
scored 149, 147 and 146. The prompt change is invisible inside the noise, and the honest
statement is not "v2 is worse" or "v2 is better" but *this dataset cannot tell*. The one
thing that is attributable, because it is the same on every run and traceable to the
changed string, is what v2 did to `claimantName`: `liability-22` fixed, `health-20` broken,
96% before and after. That is the [modelling problem](#what-v2-actually-did), and it is
real on every run.

**The harness records one run per (prompt version, model), so replicates overwrite each
other.** Run 2's record is gone; its figures survive here only because they were read out
before Run 3 replaced them. For a real deployment that is the wrong design — a run needs an
id, and the report needs to show a band rather than a point. Naming that is easy; the
reason it is not built here is that a variance-aware harness is a different piece of work
from a correctness-aware one, and 25 documents is the wrong size to build it against.

The useful next move is therefore *not* more prompt tuning against this set, and not a
fourth run in search of a better number. It is to resolve the `claimantName` modelling
question, and to grow the dataset — several hundred documents drawn from the real mix —
until a 1pp change means something. **A real deployment's first eval produces a better eval
set before it produces a better prompt.**

### Quote grounding: what the check caught

Every value the model fills in must arrive with the verbatim span it was taken from, and
`src/pipeline/grounding.ts` matches each span back against the source document — a
substring comparison, no model call, no ground truth. On the committed run:

| Metric | Result |
| --- | --- |
| Grounded spans | **97.7%** (128/131) |
| Cited fields | 100.0% (131/131) |
| Spans cited for a `null` field | 0 |

Citation discipline is perfect: every filled field carried a span, and the model never
quoted a field it had set to null. Three spans did not match, and **not one of them is a
hallucination** — every one is a real span the model reformatted:

- `liability-22` — `"On 12 March 2025 your insured, while manoeuvring a forklift ..."`. The
  text is verbatim up to the trailing ellipsis the model added to mark truncation.
- `motor-05` — `"Frau Küng meldet, dass sie am 22.05.2025 ... touchiert hat."` Two
  non-contiguous fragments joined with an ellipsis.
- `property-13` — `"...seines Einfamilienhauses."` The document hard-wraps that word as
  `Einfamilien-` / `hauses`, and the model silently rejoined it.

So the check found a **contract defect, not a dishonest model**. The schema says "the short
verbatim span from the document" and "at most about 100 characters", and never says
*contiguous, unabridged, exactly as wrapped* — so eliding a long span with `...` is a
reasonable reading of the instruction the model was given. That is a clean, attributable,
one-string [v3 candidate](#the-prompt-version-loop): tighten the `sourceQuotes` description
to forbid elision and require a contiguous span, and watch this metric rather than field
accuracy.

The hyphenation case is deliberately *not* normalised away, and the reason is what the
signal is for: the point of a grounded quote is that a reviewer can be shown the span
highlighted in the source. A rejoined compound cannot be located by literal search, so it
genuinely fails that test even though the model did nothing wrong. Folding it in would make
the metric agree with intuition and stop predicting whether the review UI can highlight
anything.

None of this proves a value is *correct*. `CHF 500.00` is a real span of `motor-01` and
supports nothing about the claimed amount — it is the deductible. Grounding is necessary
for trusting a field and never sufficient, which is why both grounding categories are
scored **soft** and reported on their own axis.

### By language

The dataset was built 11 German / 11 English / 3 mixed so that the headline could be split.
On the committed run:

| Language | Docs | Field (norm.) | `missingFields` | Urgency | Under-triaged | Category | Grounded |
| --- | ---: | --- | --- | --- | ---: | --- | --- |
| `de` | 11 | 97.0% (64/66) | 90.9% (10/11) | 100.0% | 0 | 100.0% | 96.3% (52/54) |
| `en` | 11 | 100.0% (66/66) | 100.0% (11/11) | 100.0% | 0 | 90.9% | 98.3% (59/60) |
| `mixed` | 3 | 88.9% (16/18) | 100.0% (3/3) | 100.0% | 0 | 100.0% | 100.0% (17/17) |

**Read the counts, not the percentages.** The German column is behind the English one by
two field cells, and both are on the *same document*: `property-08` left `dateOfLoss` null
on an email whose letterhead date resolves it, and returned the policy number as
`Police CH-HH-2023-559012` with the German label word swept into the value. The `mixed`
row is three documents, so its 88.9% is `health-20` alone — the `claimantName` modelling
problem in a different costume, plus the `claimType` it dragged down with it. English is
not ahead on everything either: the run's only `category-mismatch` is English
(`health-16`, a ski accident filed as `health-treatment` rather than `health-accident`).

Given a 2pp replicate spread on the *whole* set, a two-cell gap between two eleven-document
buckets is not a finding. What it is worth is the shape: every German-side failure in this
run is either over-abstention or a locale artefact, and none of them is a comprehension
failure — no misparsed Swiss apostrophe, no German decimal comma read as a decimal point.
The table exists to make a systematic language effect *visible* if one develops, and to
force the question at the point where the dataset grows. On 25 documents it is a null
result, stated as one.

### Cost and latency

Every model call records its input and output tokens, its wall-clock latency and an
indicative USD cost (`meta.calls` on every pipeline result). `results.md` turns that into a
per-document table and an average; the numbers for the v2 run:

| | Per document | Per 1,000 documents |
| --- | --- | --- |
| Tokens | 1,720 in / 779 out | 1.72M in / 0.78M out |
| Cost | ~$0.0020 | ~$1.99 |
| Latency | 10.1 s mean, 9.8 s median, 16.4 s slowest | — |

Latency is the *document* wall clock — `extract` then `triage`, in sequence. Documents run
concurrently during an eval, so 25 of them do not take 4 minutes.

Two things are worth reading off that table. First, unit cost is not the constraint here: at
roughly two-tenths of a cent per document, a handler spending sixty seconds on the same task
is orders of magnitude more expensive, so the question a deployment has to answer is about
accuracy and trust, not spend. Second, the split into two calls really does cost what the
[architecture note](../README.md#architecture) says it costs — `triage` re-sends the
document alongside the
validated extraction, so the two calls price out at roughly the same amount rather than the
second being a cheap tail. (The per-call breakdown is visible on the browser page; the
committed run records predate per-call capture and hold per-document totals only.) Merging
the two schemas would take most of that back, and would cost the eval its ability to tell an
extraction error from a classification error. At these prices that is not a close call — but
it is now *a* call rather than an assumption.

Prices come from the hard-coded table in `src/config.ts` and are applied when the report is
rendered, not when the run happens — so a stale price never gets baked into a committed run
record. An unlisted model reports `n/a`, not `$0.00`.

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

Each run writes `results/run-<version>--<model>.json`, and the report renders every run
record it finds side by side with per-metric deltas — so the comparison table fills itself
in.

Three cautions these runs earned the hard way. Changing more than one thing per version
makes the delta unattributable, which is why the recipe insists on one. A delta smaller
than a couple of documents is not evidence of anything at this dataset size — check the
per-field rows and the failure log before believing a headline improvement. And **run the
new version at least twice before believing either direction**: three runs of `v2` spanned
2pp with nothing changed, so a single run of `v3` scoring a point higher than a single run
of `v2` is a coin flip with extra steps.

**The `v3` this repo is actually asking for is not an accuracy change.** Field accuracy has
no attributable headroom left at this dataset size — the noise floor is wider than any
plausible prompt effect. Quote grounding does: three spans failed the check on the
committed run, all three for the same reason, and the fix is one string. Tighten the
`sourceQuotes` description to require a *contiguous, unabridged* span and forbid `...`
elision, then read the grounding rate rather than the headline. That is a target where a
one-string change can move a metric by more than the noise, which is the only kind of
prompt experiment worth running against 25 documents.

### Comparing models

A run record is keyed by the **pair** (prompt version, model), because those are the two
things that can change underneath a number. Holding one fixed and varying the other is
the only way to read the result:

```bash
npx tsx src/cli/eval.ts --concurrency 8
```

with `PROMPT_VERSION=v2` and `OPENAI_MODEL=gpt-5` in `.env` writes
`results/run-v2--gpt-5.json` beside the existing `run-v2--gpt-5-mini.json` and adds a
column. Nothing is overwritten, and `src/openai/client.ts` already switches between
`reasoning.effort` and `temperature` on the model id, so no code changes.

When run records span more than one model the report labels each column with both halves
of the key and prints a caution, because a delta between two columns that differ in
prompt *and* model is not attributable to either.

### What the model comparison found

**The frontier model is the wrong buy for this task, and nothing but an eval could have
told me that.** `v2` ran against three models with the prompt text, the schemas and the
dataset byte-identical and `OPENAI_REASONING_EFFORT` fixed at `low`, so the model is the
only thing that changed.

| `v2` on | Field (norm.) | Urgency | Under-triaged | Category | Hard failures | Cost / run | Latency / doc |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `gpt-5-mini` | 97.3% | **100.0%** | **0** | 96.0% | 6 | $0.0495 | 10.5 s |
| `gpt-5` | 97.3% | 96.0% | 1 | 100.0% | 8 | $0.3147 | 13.2 s |
| `gpt-4.1-mini` | 98.0% | 84.0% | 4 | 92.0% | 11 | $0.0264 | 4.8 s |

**Ignore the first column.** It was always the weakest evidence here, and the
[replicate](#the-replicate-that-settled-it) finished the job: `gpt-5-mini` alone spans
97.3–99.3% across three identical runs, which is wider than the entire spread between the
three models. On this dataset the three are indistinguishable on extraction accuracy, and
the cheapest model happens to top the column. Anyone reading a model recommendation off
that column is reading noise — including the earlier version of this section, which
reported `gpt-5-mini` at 99.3% and had to be corrected. The columns that survive
replication are the ones on the right.

**`gpt-5` costs 6.4× more, runs 26% slower, and buys nothing.** It ties on extraction,
loses on urgency, and produced this project's first under-triage. There is no measurement
here that justifies paying six times as much, and the default assumption that the biggest
model is the safe choice is simply false on this workload. `gpt-5-mini` is the
recommendation, and it is not close.

**`gpt-4.1-mini` is disqualified, and not by its field accuracy.** At 98.0% — nominally the
best in the table — it extracts
about as well as anything, at half the cost and half the latency — and then under-triages
4 of 25 documents. Three of those are `high` scored as `normal`: a ski accident with an
injury, a dog bite with an injury, and the lawyer's letter carrying a legal deadline.
Those are the rubric's own three `high` triggers. That is not a calibration wobble, it is
a model failing to apply a rubric it was handed in full, and 16pp across 4 documents is
far too large to blame on sampling. For a product whose entire job is to stop an injury
sitting in a queue, cheap and fast is worth exactly nothing.

**The `claimantName` question is settled — the pessimistic answer was right.** `gpt-5` gets
`liability-22` right, like `gpt-5-mini`, so v2's precise wording does work on a capable
model. But `gpt-5` also returns `Petrović Bau AG` on `health-20`, exactly as `gpt-5-mini`
does. A stronger model does not rescue it, and would not be expected to: on a UVG
workplace-accident policy the policyholder *is* the employer, so the more faithfully a
model follows v2's instruction the more certainly it returns the company rather than the
injured employee. That confirms the conclusion reached from the v1 → v2 run — this is a
**modelling** problem, not a capability ceiling, and no prompt or model change fixes it.
The fix is two fields, or a per-`claimType` rule, and it is a discovery question.
`gpt-4.1-mini` fails `liability-22` too, so it is the only model here that v2's wording
does not reach at all.

None of this escapes the sample size, and it does not need to. The replicate puts a number
on the noise floor — roughly 2pp, or three field cells — and the recommendation is built
entirely out of things that clear it: a 6.4× price difference, and four under-triaged
documents including two injuries and a legal deadline. Those are not artefacts 25 documents
can manufacture. Everything inside the noise floor is reported and then explicitly not
relied on.

One caveat this table cannot escape: **`gpt-5` and `gpt-4.1-mini` have been run once
each.** Their under-triage counts are single draws from distributions whose width is
unmeasured. The gap being relied on — 0 versus 4 — is far larger than anything the
`gpt-5-mini` replicates produced, which is why the conclusion stands; but the honest
version of this table has three runs per model, and that is the first thing I would spend
money on before taking the recommendation to a customer.

## Failure analysis

Eleven of the eighteen categories have now fired at least once. On `gpt-5-mini` the v1 run
produced `missed-field`, `spurious-missing-field` and `name-mismatch`; the v2 runs added
`category-mismatch`, then `claim-type-mismatch`, `policy-number-mismatch` and
`ungrounded-quote`. The model comparison added three more: `urgency-mismatch` on both
`gpt-5` and `gpt-4.1-mini`, and `hallucinated-field` and `missed-missing-field` on
`gpt-4.1-mini` alone — the two categories that say a model is inventing values and failing
to notice it.

That spread is the argument for the taxonomy. A bucket that sits empty for four runs and
then catches something costs nothing to have kept, and the alternative — a single "wrong"
counter — would have rendered every one of those as the same number going down. The
taxonomy in `src/eval/taxonomy.ts` is built so that each category maps to a different
*action*, not just a different symptom, which is what let five v1 records resolve to two
causes, made the v2 regression legible as a regression, and turned three unmatched quotes
into a one-line schema fix rather than a vague worry about hallucination:

| Category | What it implies |
| --- | --- |
| `date-format`, `amount-format` | Output-contract drift. Schema description or prompt fix. Counted separately as *soft* failures — the value normalises correctly, but any downstream consumer parsing raw output still breaks. |
| `date-value`, `amount-value` | Comprehension failure. Usually a report date taken for a loss date, or a deductible taken for a claimed amount. Prompt or few-shot fix. |
| `hallucinated-field` vs `missed-field` | Opposite calibration errors, fixed by opposite changes. Collapsing them into "wrong" throws away the only thing that tells you which way to push. |
| `missed-missing-field`, `spurious-missing-field` | The model's self-knowledge. This is the metric that decides whether the completeness output can be trusted to drive an automated reply. |
| `name-mismatch`, `policy-number-mismatch` | Distractor sensitivity — brokers, adjusters, lawyers, injured third parties, claim and invoice numbers. The dataset seeds all of these deliberately. |
| `ungrounded-quote` vs `missing-quote` | Fabricated evidence versus absent evidence, and again opposite fixes. A cited span that is not in the document means the value behind it cannot be trusted at all; no span at all means the value is merely unverifiable. Both are scored **soft** — grounding is reported as its own metric, and folding it into field accuracy would double-count the evidence. |
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
- **Verifiable citations should be a first-class output, not a schema convention.** Asking
  for `sourceQuotes` and checking them costs one substring search and yields the only
  quality signal in this pipeline that survives contact with unlabelled production data.
  Every extraction deployment will rebuild it. A guarantee that a cited span is copied
  rather than generated — enforced at decode time the way Structured Outputs enforces
  shape — would be worth more than a point of accuracy, because it converts a trust
  problem into a check.
- **Locale handling is a recurring, unglamorous tax.** `12'450.00`, `8.500,00`,
  `Fr. 3'200.—`, `03/04/2025`. Every European deployment writes the same normalization
  code and the same prompt paragraph. Worth handling in the schema layer rather than
  leaving to every integrator.
- **Strict-mode schema authoring has sharp edges** — nullable-as-union, every property
  required, `additionalProperties: false` everywhere. Fine once learned, but it is the
  step where an FDE loses an afternoon on a first deployment.
