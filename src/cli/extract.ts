/**
 * Single-document CLI.
 *
 *   npm run extract -- data/docs/motor-01-collision-zurich.txt
 *   npx tsx src/cli/extract.ts data/docs/motor-01-collision-zurich.txt --json
 *
 * Prints the human-readable summary plus the full JSON payload. `--json` prints only the
 * JSON, so the command composes with jq and friends.
 *
 * The file path survives `npm run extract -- <path>`, but `--json` does not: npm treats
 * a `--flag` after the `--` separator as one of its own config keys and drops it. Use
 * `npx tsx` when passing flags.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { MODEL } from '../config.js';
import { getPromptSet } from '../prompts/index.js';
import { runPipeline } from '../pipeline/run.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const jsonOnly = args.includes('--json');
  const target = args.find((arg) => !arg.startsWith('-'));

  if (!target || args.includes('--help') || args.includes('-h')) {
    console.error(
      [
        'Usage: npx tsx src/cli/extract.ts <path-to-document.txt> [--json]',
        '',
        '  npm run extract -- <path>   also works; the path survives, but flags do not -',
        '                              npm consumes "--json" as one of its own config keys.',
      ].join('\n'),
    );
    process.exitCode = target ? 0 : 1;
    return;
  }

  const resolved = path.resolve(process.cwd(), target);
  const text = await readFile(resolved, 'utf8');
  const prompts = getPromptSet();
  const documentId = path.basename(resolved, path.extname(resolved));

  if (!jsonOnly) {
    console.error(`model=${MODEL} prompts=${prompts.version} doc=${documentId}`);
  }

  const result = await runPipeline(documentId, text, prompts);

  if (jsonOnly) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`\n${result.summary}\n`);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error: unknown) => {
  console.error(`\nFailed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
