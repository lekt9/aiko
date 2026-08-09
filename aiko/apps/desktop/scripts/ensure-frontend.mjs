import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const desktop = resolve(import.meta.dirname, '..');
const repo = resolve(desktop, '../../..');
const packageJson = resolve(desktop, '../frontend/frontend/package.json');
if (!existsSync(packageJson)) {
  const update = spawnSync(
    'git',
    ['submodule', 'update', '--init', '--recursive', 'aiko/apps/frontend'],
    { cwd: repo, stdio: 'inherit' },
  );
  if (update.status !== 0 || !existsSync(packageJson)) {
    throw new Error(
      'Aiko frontend is unavailable. Initialize aiko/apps/frontend or check network access.',
    );
  }
}
process.stdout.write(`Frontend ready: ${packageJson}\n`);
