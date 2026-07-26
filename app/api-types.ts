/** The `/api/triage` wire contract, shared by the route and the form. */

import type { TriageResult } from '../src/types.js';

export interface TriageResponse {
  result: TriageResult;
}

export interface ErrorResponse {
  error: string;
}
