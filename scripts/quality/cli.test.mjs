import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const CLI = join(HERE, 'cli.mjs');
const FIXTURES = join(HERE, 'fixtures');

function run(args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
  });
}

function parseJson(result) {
  return JSON.parse(result.stdout);
}

function readFixture(name) {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));
}

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'comfyrizz-q17-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeCleanProduction(dir) {
  const clean = readFixture('sandwich-plan.json').cases.clean;
  writeFileSync(join(dir, 'beats.json'), JSON.stringify({ beats: clean.beats }));
  writeFileSync(join(dir, 'shots.json'), JSON.stringify({ shots: clean.shots }));
  writeFileSync(join(dir, 'script.json'), JSON.stringify(clean.script));
}

test('the sandwich fixture exits 1 and names the contradicted beat', () => {
  const result = run(['beats', join(FIXTURES, 'sandwich-plan.json')]);

  assert.equal(result.status, 1);
  assert.match(result.stdout, /s08_unreachable_sandwich/);
  assert.match(result.stdout, /PROMPT_CONTRADICTS/);
});

test('spawning on the fixtures directory finds the sandwich plan', () => {
  const result = run(['beats', FIXTURES]);

  assert.equal(result.status, 1);
  assert.match(result.stdout, /s08_unreachable_sandwich/);
  assert.match(result.stdout, /SPEAKER_UNASSIGNED/);
});

test('a clean production exits 0', (t) => {
  const dir = tempDir(t);
  writeCleanProduction(dir);

  const result = run(['beats', dir, '--json']);
  const report = parseJson(result);

  assert.equal(result.status, 0);
  assert.equal(report.ok, true);
  assert.equal(report.exitCode, 0);
  assert.deepEqual(report.findings, []);
});

test('a not_reviewed critical beat exits 1', (t) => {
  const dir = tempDir(t);
  writeCleanProduction(dir);
  writeFileSync(
    join(dir, 'verdicts.json'),
    JSON.stringify({
      verdicts: [
        { beat: 's08_unreachable_sandwich', status: 'not_reviewed' },
        { beat: 's02_chair_gag', status: 'not_reviewed' },
      ],
    }),
  );

  const result = run(['beats', dir, '--json']);
  const report = parseJson(result);

  assert.equal(result.status, 1);
  assert.equal(report.ok, false);
  assert.ok(report.findings.some((finding) => finding.code === 'NOT_REVIEWED'));
});

test('a single JSON file can carry the pre-generation plan', (t) => {
  const dir = tempDir(t);
  const clean = readFixture('sandwich-plan.json').cases.clean;
  const file = join(dir, 'production.json');
  writeFileSync(
    file,
    JSON.stringify({ beats: clean.beats, shots: clean.shots, script: clean.script }),
  );

  const result = run(['beats', file, '--json']);

  assert.equal(result.status, 0);
  assert.equal(parseJson(result).ok, true);
});

test('every command emits parseable JSON on the fixtures directory', () => {
  for (const command of ['beats', 'takes', 'continuity', 'edit', 'captions', 'sound', 'receipt']) {
    const result = run([command, FIXTURES, '--json']);
    const report = parseJson(result);

    assert.equal(report.schema, 'comfyrizz.quality-cli/v1', command);
    assert.equal(report.command, command);
    assert.ok(Array.isArray(report.findings), command);
    assert.equal(result.status, report.exitCode, command);
    assert.equal(result.status, 1, command);
  }
});

test('the review fixtures surface their expected finding codes', () => {
  const cases = {
    takes: 'UNGROUNDED',
    continuity: 'ARTWORK_SWAP',
    edit: 'TAIL_UNEXPLAINED',
    captions: 'CAPTION_OVER_CPS',
    sound: 'FOLEY_FRAME_MISMATCH',
  };

  for (const [command, code] of Object.entries(cases)) {
    const report = parseJson(run([command, FIXTURES, '--json']));
    assert.ok(
      report.findings.some((finding) => finding.code === code),
      `${command} should report ${code}`,
    );
  }
});

test('the receipt is not approved while an axis is not_reviewed', () => {
  const report = parseJson(run(['receipt', FIXTURES, '--json']));

  assert.equal(report.ok, false);
  assert.equal(report.passes.receipt.approved, false);
  assert.ok(
    Object.values(report.passes.receipt.states).includes('not_reviewed'),
    'missing reviews stay not_reviewed',
  );
});

test('output never carries more than an 80-character preview of file text', (t) => {
  const dir = tempDir(t);
  const marker = `LONGCAPTION${'x'.repeat(240)}`;
  writeFileSync(
    join(dir, 'captions.json'),
    JSON.stringify({
      cues: [{ speaker: 'Ada', text: marker, start: 0, end: 1 }],
    }),
  );

  const result = run(['captions', dir, '--json']);
  const report = parseJson(result);

  assert.equal(result.status, 1);
  assert.equal(result.stdout.includes(marker), false);
  for (const finding of report.findings) {
    assert.ok(finding.message.length <= 80, finding.code);
  }
});

test('human output truncates long finding messages and omits local paths', () => {
  const result = run(['captions', FIXTURES]);
  const captions = readFixture('captions.json');
  const longest = captions.cues
    .map((cue) => cue.text)
    .sort((left, right) => right.length - left.length)[0];

  assert.equal(result.status, 1);
  assert.equal(result.stdout.includes(longest), false);
  assert.equal(result.stdout.includes(ROOT), false);
});
