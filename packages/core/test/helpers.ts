import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBackup, type Month, type PlannerState } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURES = join(here, '../../../fixtures');
export const fixture = (name: string) => readFileSync(join(FIXTURES, name), 'utf8');
export const sampleState = (): PlannerState => readBackup(fixture('sample-backup.json'));
export const sampleMonth = (): Month => sampleState().months['2026-11'];

let n = 0;
export const seqId = () => `t${++n}`;

/** The household's real exports, only when PRIVATE_FIXTURES points at them (never committed). */
export function privateFile(re: RegExp): string | null {
  const dir = process.env.PRIVATE_FIXTURES;
  if (!dir || !existsSync(dir)) return null;
  const f = readdirSync(dir).find(x => re.test(x));
  return f ? readFileSync(join(dir, f), 'utf8') : null;
}
