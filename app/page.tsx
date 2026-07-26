/**
 * The demo's only route.
 *
 * A server component that resolves the run configuration and one sample document, then
 * hands both to the client form. Reading the sample here rather than duplicating a
 * document into the web code keeps `data/docs/` the single source of it.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { MODEL, PROMPT_VERSION } from '../src/config.js';
import { TriageForm } from './triage-form.js';

const SAMPLE = 'motor-01-collision-zurich.txt';

/**
 * Rendered per request rather than prerendered, so that changing `OPENAI_MODEL` or
 * `PROMPT_VERSION` in `.env` and restarting shows the new values instead of whatever
 * was baked in at build time.
 */
export const dynamic = 'force-dynamic';

/**
 * `process.cwd()` is the project root under both `next dev` and `next start`. The
 * pipeline's own `PATHS` are derived from `import.meta.url`, which a bundler rewrites to
 * point inside `.next/`, so they are not usable here.
 */
async function loadSample(): Promise<string> {
  try {
    return await readFile(path.join(process.cwd(), 'data', 'docs', SAMPLE), 'utf8');
  } catch {
    // The page is still perfectly usable by pasting; only the sample button goes away.
    return '';
  }
}

export default async function Page() {
  const sample = await loadSample();

  return (
    <main>
      <header>
        <h1>claim-triage</h1>
        <p className="lede">
          Paste an insurance claim document - German or English, email, claim form, broker
          note - and run the same pipeline the CLI and the eval harness use: structured
          extraction, a deterministic completeness check, then triage.
        </p>
        <p className="config">
          model <code>{MODEL}</code> · prompts <code>{PROMPT_VERSION}</code> · two model
          calls per document
        </p>
      </header>

      <TriageForm sample={sample} sampleName={SAMPLE} />

      <footer>
        Accuracy numbers for this pipeline are in <code>results.md</code>; this page is a
        way to try it, not a way to measure it.
      </footer>
    </main>
  );
}
