'use client';

import { useState } from 'react';
import type { ErrorResponse, TriageResponse } from './api-types.js';
import type { ModelCallStats, TriageResult } from '../src/types.js';

interface Props {
  /** Contents of a document from `data/docs/`, or '' if it could not be read. */
  sample: string;
  sampleName: string;
}

type State =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'error'; message: string }
  | { status: 'done'; result: TriageResult };

function money(costUsd: number | null): string {
  return costUsd === null ? 'unpriced model' : `~$${costUsd.toFixed(5)}`;
}

function list(values: readonly string[]): string {
  return values.length === 0 ? 'none' : values.join(', ');
}

export function TriageForm({ sample, sampleName }: Props) {
  const [text, setText] = useState('');
  const [state, setState] = useState<State>({ status: 'idle' });
  const running = state.status === 'running';

  async function run(): Promise<void> {
    setState({ status: 'running' });
    try {
      const response = await fetch('/api/triage', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      const payload = (await response.json()) as TriageResponse | ErrorResponse;
      if (!response.ok) {
        setState({ status: 'error', message: 'error' in payload ? payload.error : 'Request failed.' });
        return;
      }
      setState({ status: 'done', result: (payload as TriageResponse).result });
    } catch (error) {
      setState({ status: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  }

  return (
    <>
      <section>
        <div className="toolbar">
          <label htmlFor="document">Document text</label>
          {sample ? (
            <button type="button" className="link" onClick={() => setText(sample)} disabled={running}>
              load sample ({sampleName})
            </button>
          ) : null}
        </div>
        <textarea
          id="document"
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Paste a claim notification, broker note, or claim form..."
          rows={14}
          spellCheck={false}
          disabled={running}
        />
        <div className="toolbar">
          <button type="button" onClick={() => void run()} disabled={running || text.trim() === ''}>
            {running ? 'Running two model calls...' : 'Run triage'}
          </button>
          <span className="hint">{text.length.toLocaleString('en')} characters · takes ~10s</span>
        </div>
      </section>

      {state.status === 'error' ? (
        <section className="error">
          <h2>Failed</h2>
          <p>{state.message}</p>
        </section>
      ) : null}

      {state.status === 'done' ? <Result result={state.result} /> : null}
    </>
  );
}

function Result({ result }: { result: TriageResult }) {
  const { extraction, completeness, triage, summary, meta } = result;

  return (
    <>
      <section>
        <h2>Summary</h2>
        <p className="summary">{summary}</p>
        <p className="note">
          Built in code from the fields below, not generated - a deterministic line cannot
          hallucinate a policy number.
        </p>
      </section>

      <section>
        <h2>Triage</h2>
        <dl>
          <dt>Urgency</dt>
          <dd>
            <span className={`badge badge-${triage.urgency}`}>{triage.urgency}</span>
          </dd>
          <dt>Category</dt>
          <dd>
            <code>{triage.category}</code>
          </dd>
          <dt>Recommended action</dt>
          <dd>{triage.recommendedAction}</dd>
          <dt>Rationale</dt>
          <dd className="muted">{triage.rationale}</dd>
        </dl>
      </section>

      <section>
        <h2>Completeness</h2>
        <dl>
          <dt>Routable</dt>
          <dd>
            {completeness.isComplete
              ? 'yes - every required field has a value'
              : 'no - required fields are missing'}
          </dd>
          <dt>Missing (deterministic check)</dt>
          <dd>
            <code>{list(completeness.missing)}</code>
          </dd>
          <dt>Missing (model self-report)</dt>
          <dd>
            <code>{list(extraction.missingFields)}</code>
          </dd>
          <dt>Disagreements</dt>
          <dd>
            <code>{list(completeness.disagreements)}</code>
          </dd>
        </dl>
        <p className="note">
          The check is a loop over the required fields, not a model call. Comparing it
          against the model&apos;s own <code>missingFields</code> is what makes a
          disagreement visible - and a non-empty disagreement list is the signal to route
          this document to a human.
        </p>
      </section>

      <section>
        <h2>Extraction</h2>
        <pre>{JSON.stringify(extraction, null, 2)}</pre>
      </section>

      <section>
        <h2>Cost and latency</h2>
        <table>
          <thead>
            <tr>
              <th>Call</th>
              <th>Input tok</th>
              <th>Output tok</th>
              <th>Cost</th>
              <th>Latency</th>
            </tr>
          </thead>
          <tbody>
            {meta.calls.map((call: ModelCallStats) => (
              <tr key={call.stage}>
                <td>
                  <code>{call.stage}</code>
                </td>
                <td>{call.usage.inputTokens.toLocaleString('en')}</td>
                <td>{call.usage.outputTokens.toLocaleString('en')}</td>
                <td>{money(call.costUsd)}</td>
                <td>{call.latencyMs.toLocaleString('en')} ms</td>
              </tr>
            ))}
            <tr className="total">
              <td>total</td>
              <td>{meta.usage.inputTokens.toLocaleString('en')}</td>
              <td>{meta.usage.outputTokens.toLocaleString('en')}</td>
              <td>{money(meta.costUsd)}</td>
              <td>{meta.latencyMs.toLocaleString('en')} ms</td>
            </tr>
          </tbody>
        </table>
        <p className="note">
          model <code>{meta.model}</code> · prompts <code>{meta.promptVersion}</code> ·
          costs are indicative, from the price table in <code>src/config.ts</code>.
        </p>
      </section>
    </>
  );
}
