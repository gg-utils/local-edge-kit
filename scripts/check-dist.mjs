import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const temporary = mkdtempSync(join(tmpdir(), 'check-dist-'));
try {
  cpSync('dist', join(temporary, 'dist'), { recursive: true });
  rmSync('dist', { recursive: true });
  const build = spawnSync('npm', ['run', 'build'], { stdio: 'inherit' });
  if (build.status !== 0) process.exitCode = 1;
  else process.exitCode = spawnSync('git', ['diff', '--no-index', '--exit-code', join(temporary, 'dist'), 'dist'], { stdio: 'inherit' }).status === 0 ? 0 : 1;
} finally { rmSync(temporary, { recursive: true, force: true }); }
