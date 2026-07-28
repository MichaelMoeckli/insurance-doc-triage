# What I would do next in a real deployment

Deliberately *not* built. This is the part of an engagement that comes after a prototype
earns the right to exist, and guessing at it in code would mean inventing the customer
decisions it depends on.

## Discovery questions, before writing more code

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

## Data privacy

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

## Human-in-the-loop routing for low-confidence extractions

Nothing here should run unattended on day one, and the thing that makes staged automation
possible is that confidence is assessed **per field**, not per document. A claim can have a
policy number worth trusting and a date of loss that is a coin flip; a single per-document
score would either block the whole claim or wave the bad date through. So the gate I would
propose sits between extraction and any downstream system, and it operates on fields.

*What marks a field as low-confidence.* Four signals, all available today and none of them
requiring a new model call:

- The field appears in the model's self-reported `missingFields`, or came back `null`.
- The field appears in `completeness.disagreements` — the model's self-report and the
  deterministic check contradict each other. This one is the strongest signal in the system:
  the model is wrong *about itself*, so nothing else it said about that field is load-bearing.
- The field's `sourceQuote` is absent, or does not actually occur in the source document.
  This one is **built** — `src/pipeline/grounding.ts`, on every pipeline result as
  `grounding.ungrounded` and `grounding.uncited`, and visible on the browser page. It is a
  cheap, deterministic hallucination check and it is the reason `sourceQuotes` is in the
  schema at all. Note what it does *not* prove: `CHF 500.00` is a real span of `motor-01`
  and supports nothing about the claimed amount — it is the deductible. Grounding is
  necessary for trusting a field, never sufficient.
- The field belongs to a class the eval says is weak. Per-field accuracy in `results.md` is
  exactly this, and on multi-party documents — a liability claim with a broker, a lawyer and
  an injured third party — `claimantName` should be treated as low-confidence by default
  until the modelling question behind it is settled. It is the one field that misses on
  *every* run. Note the discipline the replicate imposes here too: a field that scored 100%
  on one run and 96% on the next has not earned a different tier, so this rule needs to be
  set from a per-field figure that is stable across runs, not from the latest one.

*What happens then.* Low-confidence fields are flagged and held: the claim is written to a
review queue with the extraction pre-filled, the uncertain fields highlighted alongside their
source quotes, and the document open beside them, so the handler confirms or corrects rather
than re-keys. **No flagged field reaches a downstream system — policy administration, reserve
setting, an auto-acknowledgement to the customer — until a human has cleared it.** Everything
unflagged flows straight through. A document with no missing fields, no disagreements, quotes
that check out, and `normal` or `low` urgency needs no human at all; a document with one bad
date needs a human for one field, not for six.

*Two rules on top of the routing.* Never auto-action a `high` urgency claim in either
direction — those are expensive as false positives and as false negatives. And start in
shadow mode: run the pipeline alongside the existing human process for a few weeks and
compare, before any output reaches a customer.

*The queue is also the label pipeline.* Every correction a handler makes is a labelled
example, captured at the moment someone who knows the answer is already looking at the
document. That is how the eval set grows past 25 documents into something representative, and
it is the only sustainable source of labels — which makes the review UI a data-collection
instrument, not just a safety net, and worth building properly.

Described here, deliberately not built: the confidence rules are a customer-specific policy
question (which fields may flow through unreviewed is a risk decision, not an engineering
one), and building a review queue against invented thresholds would be guessing at the part
that matters most.

## Monitoring

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
