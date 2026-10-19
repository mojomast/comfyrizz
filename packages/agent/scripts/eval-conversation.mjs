/** Live behavioral evals. Credentials stay in the server's settings; projects are isolated. */
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createProviderSettings } from '../../../apps/server/src/provider-settings.mjs';
import { createProjectChat } from '../../../apps/server/src/agent-chat.mjs';
import { PackageStore } from '../../../apps/server/src/store.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
const source = resolve(option('--settings-dir', 'apps/server/.runtime'));
const output = resolve(option('--output', '.runtime/evals/conversation.json'));
const filter = option('--case', '');
const cases = JSON.parse(readFileSync(new URL('../evals/conversation-cases.json', import.meta.url), 'utf8')).filter(c => !filter || c.id === filter);
const settings = createProviderSettings({ runtimeDir: source });
const provider = 'opencode-go';
const model = 'deepseek-v4.1-flash';
settings.resolve(provider, model); // Fail before running if no credential is available.
mkdirSync('/tmp/opencode', { recursive: true });
const runtimeDir = mkdtempSync('/tmp/opencode/comfyrizz-skill-eval-');
const store = new PackageStore(join(runtimeDir, 'packages'));
const chat = createProjectChat({ runtimeDir, store, providerSettings: settings, skillsEnabled: !args.includes('--without-skills') });
const results = { at: new Date().toISOString(), provider, model, skillsEnabled: !args.includes('--without-skills'), label: option('--label', 'skills'), turns: [] };
const clone = value => structuredClone(value);
const stripSecondHeadline = p => { const copy = clone(p); if (copy?.scenes[1]) copy.scenes[1].headline = ''; return copy; };
function check(expect, result, previous) {
  const failures = [];
  const p = result.conversation.plan;
  const test = (ok, reason) => { if (!ok) failures.push(reason); };
  if ('built' in expect) test(result.built === expect.built, `built should be ${expect.built}`);
  if ('plan' in expect) test(Boolean(p) === expect.plan, `plan should exist: ${expect.plan}`);
  if (expect.scenes) test(p?.scenes.length === expect.scenes, `expected ${expect.scenes} scenes`);
  if (expect.seconds) test(Math.abs((p?.scenes.reduce((n, s) => n + s.seconds, 0) ?? 0) - expect.seconds) <= 1, `expected ${expect.seconds}s (±1s)`);
  if (expect.aspect) test(p?.aspect === expect.aspect, `expected ${expect.aspect}`);
  if (expect.media) test(p?.scenes.every(s => s.mediaType === expect.media), `expected ${expect.media}-only visuals`);
  if (expect.mustNotMatch) test(!new RegExp(expect.mustNotMatch, 'i').test(p?.scenes.map(s => [s.headline, s.sub, s.body, ...s.items, s.narration].join(' ')).join(' ') ?? ''), 'unsupported claim entered copy');
  if (expect.headline) test(p?.scenes[1]?.headline === expect.headline, 'second headline should match requested copy');
  if (expect.samePlan) test(isDeepStrictEqual(p, previous?.conversation.plan), 'plan changed unexpectedly');
  if (expect.sameProject) test(isDeepStrictEqual(result.project?.package, previous?.project?.package), 'project changed unexpectedly');
  if (expect.sameIds) test(isDeepStrictEqual(p?.scenes.map(s => s.id), previous?.conversation.plan?.scenes.map(s => s.id)), 'scene IDs changed');
  if (expect.preserveExceptSecondHeadline) test(isDeepStrictEqual(stripSecondHeadline(p), stripSecondHeadline(previous?.conversation.plan)), 'unrelated plan fields changed');
  return failures;
}
try {
  for (const scenario of cases) {
    let previous;
    for (const [index, turn] of scenario.turns.entries()) {
      const start = Date.now();
      try {
        const result = await chat.send({ provider, model, message: turn.message,
          conversationId: previous?.conversation.id, baseRevision: previous?.conversation.revision,
          turnId: `eval-${scenario.id}-${index}`, mode: scenario.id.startsWith('express') ? 'express' : 'plan' });
        const failures = check(turn.expect, result, previous);
        results.turns.push({ case: scenario.id, turn: index + 1, message: turn.message, ms: Date.now() - start, failures, result });
        previous = result;
        console.log(`${failures.length ? 'FAIL' : 'PASS'} ${scenario.id}/${index + 1} ${Date.now() - start}ms ${failures.join('; ')}`);
      } catch (error) {
        results.turns.push({ case: scenario.id, turn: index + 1, message: turn.message, ms: Date.now() - start, failures: [settings.redact(error.message)] });
        console.log(`ERROR ${scenario.id}/${index + 1}: ${settings.redact(error.message)}`);
        break;
      }
      mkdirSync(resolve(output, '..'), { recursive: true });
      writeFileSync(output, settings.redact(JSON.stringify(results, null, 2)), { mode: 0o600 });
    }
  }
} finally {
  results.summary = { turns: results.turns.length, passed: results.turns.filter(t => !t.failures.length).length, failed: results.turns.filter(t => t.failures.length).length };
  mkdirSync(resolve(output, '..'), { recursive: true });
  writeFileSync(output, settings.redact(JSON.stringify(results, null, 2)), { mode: 0o600 });
  rmSync(runtimeDir, { recursive: true, force: true });
  console.log(JSON.stringify(results.summary));
}
if (results.summary.failed) process.exitCode = 1;
