import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { tailReport, FLAG_CODES } from './dialogue-tails.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(here, 'fixtures', 'voice-manifest.json'), 'utf8'),
);

const report = tailReport(fixture);

test('fixture totals 86.96 s of trailing padding, 14.49% of the 600 s film', () => {
  assert.equal(fixture.segments.length, 20);
  assert.equal(report.totalTrailingS, 86.96);
  assert.equal(report.shareOfFilm, 0.1449);
  assert.equal(report.shareOfFilmPct, 14.49);
  assert.equal(report.filmS, 600);
  assert.equal(report.sampleRate, 24000);
});

test('every segment reports its trailing seconds and speed', () => {
  assert.equal(report.segments.length, 20);
  const ch05 = report.segments.find((s) => s.id === 'ch05');
  assert.equal(ch05.trailingS, 8.45);
  assert.equal(ch05.speed, 1);
  const ch17 = report.segments.find((s) => s.id === 'ch17');
  assert.equal(ch17.trailingS, 0.31);
  assert.equal(ch17.speed, 1.15);
});

test('chapter 5 (8.45 s) and chapter 19 (7.95 s) are flagged as unexplained tails', () => {
  const tails = report.flagged.filter((f) => f.code === FLAG_CODES.TAIL_UNEXPLAINED);
  const byId = new Map(tails.map((f) => [f.id, f]));
  assert.ok(byId.has('ch05'), 'ch05 must be flagged');
  assert.equal(byId.get('ch05').trailingS, 8.45);
  assert.ok(byId.has('ch19'), 'ch19 must be flagged');
  assert.equal(byId.get('ch19').trailingS, 7.95);
});

test('a tail with an editorial reason is not flagged', () => {
  const flaggedIds = new Set(report.flagged.map((f) => f.id));
  // ch04 is a deliberate pause and ch09 a silent gag, both over the 2 s threshold.
  assert.ok(report.segments.find((s) => s.id === 'ch04').trailingS > report.flagS);
  assert.ok(report.segments.find((s) => s.id === 'ch09').trailingS > report.flagS);
  assert.equal(flaggedIds.has('ch04'), false);
  assert.equal(flaggedIds.has('ch09'), false);
  const ch09 = report.segments.find((s) => s.id === 'ch09');
  assert.equal(ch09.editorialReason, 'silent_gag');
});

test('chapter 17 at 1.15x speed is flagged for fitting', () => {
  const speed = report.flagged.filter((f) => f.code === FLAG_CODES.SPEED_UP);
  assert.equal(speed.length, 1);
  assert.equal(speed[0].id, 'ch17');
  assert.equal(speed[0].speed, 1.15);
});

test('tails at or under the threshold are not flagged', () => {
  const tails = report.flagged.filter((f) => f.code === FLAG_CODES.TAIL_UNEXPLAINED);
  for (const flag of tails) {
    assert.ok(flag.trailingS > report.flagS);
  }
  const ids = tails.map((f) => f.id);
  assert.equal(ids.includes('ch13'), false); // 1.95 s
  assert.equal(ids.includes('ch17'), false); // 0.31 s
});

test('the report is a pure function of its input', () => {
  const again = tailReport(fixture);
  assert.deepEqual(again, report);
  const copy = JSON.parse(JSON.stringify(fixture));
  assert.deepEqual(tailReport(copy), report);
});

test('sample rate and film length are configurable', () => {
  // The same sample counts at 48 kHz describe half as many seconds.
  const doubled = tailReport(fixture, { sampleRate: 48000 });
  assert.equal(doubled.totalTrailingS, 43.48);
  const shorter = tailReport(fixture, { filmS: 300 });
  assert.equal(shorter.shareOfFilmPct, 28.99);
});

test('the flag threshold is configurable', () => {
  const strict = tailReport(fixture, { flagS: 0 });
  const ids = strict.flagged.filter((f) => f.code === FLAG_CODES.TAIL_UNEXPLAINED).map((f) => f.id);
  assert.equal(ids.includes('ch13'), true); // 1.95 s now exceeds a 0 s threshold
  assert.equal(ids.includes('ch04'), false); // editorial reason still excuses it
});

test('a missing measurement is not treated as clean', () => {
  const manifest = {
    sampleRate: 24000,
    filmS: 600,
    segments: [{ id: 'chXX', chapter: 1, speed: 1 }],
  };
  const out = tailReport(manifest);
  assert.equal(out.segments[0].trailingS, null);
  assert.equal(out.flagged.length, 1);
  assert.equal(out.flagged[0].code, FLAG_CODES.TAIL_UNMEASURED);
});

test('malformed manifests are rejected', () => {
  assert.throws(() => tailReport(null), TypeError);
  assert.throws(() => tailReport({}), TypeError);
  assert.throws(() => tailReport({ segments: [] }, { sampleRate: 0 }), TypeError);
});

test('the report never carries secret-like values', () => {
  const text = JSON.stringify(report);
  assert.equal(/password|secret|api[_-]?key|token|bearer/i.test(text), false);
});
