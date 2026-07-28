# Running it

Quick start is in the [README](../README.md#how-to-run). This is every entry point, the
flag handling, and the configuration surface.

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
npm run report
```

Regenerates `results.md` from the run records already in `results/`. No API calls, no
spend — for when the report *renderer* changed and the report needs to catch up. Re-running
a paid eval to pick up a formatting change would also silently replace the measurements
[docs/evaluation.md](evaluation.md) analyses. `--version` and `--model` pick which run the
report treats as current; every record on disk appears in the comparison table regardless.

> **`--version` and `--model` are not optional in practice.** With neither flag the report
> picks a current run on its own, which may not be the one the analysis is written against
> — running bare `npm run report` will happily rewrite `results.md` around a different
> model. Pass both when regenerating a report you intend to keep.

```bash
npm test
```

Unit tests for the normalization and scoring logic, on Node's built-in test runner. The
harness decides what counts as correct, so it gets tested.

## Try it in a browser

```bash
npm run web
```

Then open <http://localhost:3000>. Paste a document — or press *load sample* — and the page
shows the extracted JSON, the completeness flags, the triage, the one-line summary, and the
tokens, cost and latency of each of the two model calls. It reads the same `.env`, so it
runs whatever `OPENAI_MODEL` and `PROMPT_VERSION` are set to, and no separate configuration
is involved.

It is one route (`app/page.tsx`) and one API handler (`app/api/triage/route.ts`), and the
handler is a thin adapter: it validates the request, calls `runPipeline` — the same function
the CLI and the eval harness call — and returns the result. No auth, no database, no state,
no styling framework. If the page contained any triage logic of its own, it would be
demonstrating something the eval numbers do not cover.

`npm run web:build` and `npm run web:start` produce and serve a production build.
`npm run typecheck:web` typechecks the page against `tsconfig.web.json`, which is separate
from the Node-side `tsconfig.json` for reasons documented in `next.config.mjs` — along with
why the `web:*` scripts pass `--webpack`.

## Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `OPENAI_API_KEY` | — | Required, except for `--validate-only`. |
| `OPENAI_MODEL` | `gpt-5-mini` | Any Structured-Outputs-capable model. One of the two eval axes. |
| `OPENAI_REASONING_EFFORT` | `low` | gpt-5 / o-series only. |
| `PROMPT_VERSION` | `v1` | Selects the prompt set. The other eval axis. |

All four can be set in `.env`, which is the portable way to switch prompt versions on
Windows — `PROMPT_VERSION=v2 npm run eval` is POSIX shell syntax and will not work in
PowerShell. The CLIs, the eval harness and the browser page all read that one file; Next.js
loads `.env` from the project root by itself, so there is nothing extra to configure.

`src/openai/client.ts` branches on the model id: gpt-5 and o-series models get
`reasoning.effort`, everything else gets `temperature: 0`. Switching `OPENAI_MODEL` to
`gpt-4.1-mini` works without touching code.
