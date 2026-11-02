import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ColabCli, KILL_GRACE_MS } from '../src/cli.mjs';

test('a CLI that ignores SIGTERM past its wall limit is SIGKILLed after the grace (v3 rerun: 5-minute stuck kernel connect)', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'cli-kill-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'colab');
  writeFileSync(bin, "#!/bin/sh\ntrap '' TERM\necho connecting\nsleep 60 & wait $!\nsleep 60\n");
  chmodSync(bin, 0o755);
  const cli = new ColabCli({ bin, logDir: dir });
  const started = Date.now();
  const result = await cli.run(['exec'], { wallMs: 300, silenceMs: 60000, label: 'stuck' });
  const took = Date.now() - started;
  assert.equal(result.timedOut, true);
  assert.ok(took < KILL_GRACE_MS + 3000, `settled in ${took} ms`);
});
