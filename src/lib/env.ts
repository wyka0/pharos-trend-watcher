/**
 * Minimal `.env.local` loader for tsx-run scripts (Next.js loads it natively).
 * Never overrides variables that are already present in the environment.
 */
import fs from 'node:fs';
import path from 'node:path';

export function loadEnvLocal(startDir: string = process.cwd()): string | null {
  let dir = path.resolve(startDir);
  for (let depth = 0; depth < 6; depth++) {
    const candidate = path.join(dir, '.env.local');
    if (fs.existsSync(candidate)) {
      const content = fs.readFileSync(candidate, 'utf8');
      for (const line of content.split(/\r?\n/)) {
        const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
        if (!m) continue;
        const key = m[1] as string;
        const value = (m[2] as string).replace(/^["']|["']$/g, '');
        if (process.env[key] === undefined || process.env[key] === '') {
          process.env[key] = value;
        }
      }
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
