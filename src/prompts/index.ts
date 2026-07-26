/**
 * Prompt version registry.
 *
 * The eval loop this project is built around is: run a version, read the failure
 * taxonomy in results.md, make *one* targeted change, register it as a new version,
 * re-run. Every run is stamped with its version and written to
 * `results/run-<version>.json`, and the report renders whatever versions it finds side
 * by side - so the comparison table appears the moment a second version has run.
 *
 * To add v2:
 *   1. cp src/prompts/v1.ts src/prompts/v2.ts, rename the export to `v2`, set
 *      `version: 'v2'` and write a changelog line naming the failure category you are
 *      targeting.
 *   2. Make one change. One. Two changes and you cannot attribute the delta.
 *   3. Add it to PROMPT_SETS below, then run `PROMPT_VERSION=v2 npm run eval`.
 */

import { PROMPT_VERSION } from '../config.js';
import type { PromptSet } from './types.js';
import { v1 } from './v1.js';

export const PROMPT_SETS: Record<string, PromptSet> = { v1 };

export function getPromptSet(version: string = PROMPT_VERSION): PromptSet {
  const set = PROMPT_SETS[version];
  if (!set) {
    const known = Object.keys(PROMPT_SETS).join(', ');
    throw new Error(`Unknown PROMPT_VERSION "${version}". Registered versions: ${known}.`);
  }
  return set;
}

export type { PromptSet };
