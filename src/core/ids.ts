import { randomBytes } from 'node:crypto';

/** Time-sortable, collision-resistant identifiers with a readable prefix. */
export function newId(
  prefix: 'prj' | 'tsk' | 'exe' | 'chk' | 'evt' | 'apr' | 'wsp' | 'evd' | 'sup' | 'cor',
): string {
  return `${prefix}_${Date.now().toString(36)}${randomBytes(5).toString('hex')}`;
}
