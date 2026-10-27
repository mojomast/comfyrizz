// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROCEDURE_FORMAT,
  procedureBaseName,
  redactProcedureText,
  sanitizeProcedureDocument,
  toFfmetadata,
  toWebVtt,
  vttTimestamp,
} from './format.ts';

test('redaction removes tokens, keys, tickets, links and local paths', () => {
  const cases = [
    ['open http://127.0.0.1:4175/#token=e2e-0123456789abcdef0123456789abcdef', 'open [link]'],
    ['ticket=abc.def-123 left', '[redacted] left'],
    ['#token=e2e-0123456789abcdef0123', '[redacted]'],
    ['x-comfyrizz-token: s3cr3t', '[redacted]'],
    ['Authorization: Bearer abc.def.ghi', 'Authorization: Bearer [redacted]'],
    ['key hf_abcdefghijklmnop', 'key [redacted]'],
    [`openai ${'sk-'}proj-abcdefghijklmnop`, 'openai [redacted]'],
    [`gh ${'ghp_'}abcdefghijklmnopqrst`, 'gh [redacted]'],
    ['google AIzaSyA1234567890abcdefghijk', 'google [redacted]'],
    ['jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig', 'jwt [redacted]'],
    ['hash 0123456789abcdef0123456789abcdef01', 'hash [redacted]'],
    ['saved to /home/kyle/comfy/out/video.mp4', 'saved to [path]'],
    [`saved to ${['C:', 'Users', 'kyle', 'video.mp4'].join('\\')}`, 'saved to [path]'],
    ['runtime /tmp/comfyrizz-e2e-1234/out', 'runtime [path]'],
    ['poster data:image/png;base64,iVBORw0KGgo=', 'poster [data]'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(redactProcedureText(input), expected, input);
  }
});

test('redaction keeps ordinary prompts and stage words', () => {
  assert.equal(redactProcedureText('Prompt: A friendly robot who learns to bake bread'), 'Prompt: A friendly robot who learns to bake bread');
  assert.equal(redactProcedureText('Google Colab is making your shots. Used 2 of 15 units.'), 'Google Colab is making your shots. Used 2 of 15 units.');
  assert.equal(redactProcedureText('  Plan:\n Done  '), 'Plan: Done');
});

test('redaction truncates long labels', () => {
  const text = redactProcedureText('word '.repeat(80), 20);
  assert.ok(text.length <= 20);
  assert.ok(text.endsWith('…'));
});

test('WebVTT timestamps are zero padded and never negative', () => {
  assert.equal(vttTimestamp(0), '00:00:00.000');
  assert.equal(vttTimestamp(61_005), '00:01:01.005');
  assert.equal(vttTimestamp(3_723_456), '01:02:03.456');
  assert.equal(vttTimestamp(-5), '00:00:00.000');
  assert.equal(vttTimestamp(Number.NaN), '00:00:00.000');
});

const DOC = {
  title: 'Robot; bakes = bread',
  durationMs: 9000,
  entries: [
    { atMs: 0, kind: 'start', label: 'Procedure capture started' },
    { atMs: 2000, kind: 'stage', label: 'Plan: Running' },
    { atMs: 5000, kind: 'result', label: 'Final video ready --> download' },
  ],
};

test('WebVTT holds each entry until the next one and the last until the end', () => {
  const vtt = toWebVtt(DOC);
  assert.ok(vtt.startsWith('WEBVTT\n\n'));
  assert.match(vtt, /1\n00:00:00\.000 --> 00:00:02\.000\nProcedure capture started/u);
  assert.match(vtt, /2\n00:00:02\.000 --> 00:00:05\.000\nPlan: Running/u);
  assert.match(vtt, /3\n00:00:05\.000 --> 00:00:09\.000\nFinal video ready → download/u);
});

test('ffmpeg chapters escape metadata characters and use millisecond timebase', () => {
  const meta = toFfmetadata(DOC);
  assert.ok(meta.startsWith(';FFMETADATA1\ntitle=Robot\\; bakes \\= bread\n'));
  assert.equal(meta.match(/\[CHAPTER\]/gu).length, 3);
  assert.match(meta, /TIMEBASE=1\/1000\nSTART=2000\nEND=5000\ntitle=Plan: Running/u);
});

test('steps in the same instant share one readable cue and one chapter', () => {
  const burst = {
    title: 'Burst',
    durationMs: 6000,
    entries: [
      { atMs: 1000, kind: 'start', label: 'Procedure capture started' },
      { atMs: 1001, kind: 'prompt', label: 'Prompt: robot' },
      { atMs: 1100, kind: 'stage', label: 'Plan: Done' },
      { atMs: 1200, kind: 'stage', label: 'Shots: Running' },
      { atMs: 4000, kind: 'result', label: 'Final video ready' },
    ],
  } as const;
  const vtt = toWebVtt(burst);
  assert.match(vtt, /1\n00:00:01\.000 --> 00:00:04\.000\nPrompt: robot\nPlan: Done\nShots: Running\n/u);
  assert.match(vtt, /2\n00:00:04\.000 --> 00:00:06\.000\nFinal video ready/u);
  const meta = toFfmetadata(burst);
  assert.equal(meta.match(/\[CHAPTER\]/gu).length, 2);
  assert.match(meta, /START=1000\nEND=4000\ntitle=Procedure capture started · Prompt: robot · Plan: Done · Shots: Running/u);
});

test('an empty journal still produces valid files', () => {
  assert.equal(toWebVtt({ entries: [], durationMs: 0 }), 'WEBVTT\n\n');
  assert.equal(toFfmetadata({ entries: [], durationMs: 0, title: 'x' }), ';FFMETADATA1\ntitle=x\n');
});

test('file names come from the redacted title and the local start time', () => {
  const at = new Date(2026, 9, 27, 3, 4, 5);
  assert.equal(procedureBaseName('A friendly robot who learns to bake bread', at), 'comfyrizz-procedure-a-friendly-robot-who-learns-to-bake-brea-20261027-030405');
  assert.equal(procedureBaseName('token=abc http://x.y/z', at), 'comfyrizz-procedure-run-20261027-030405');
  assert.equal(procedureBaseName('', at), 'comfyrizz-procedure-run-20261027-030405');
});

test('a journal read from disk is redacted again before reuse', () => {
  const doc = sanitizeProcedureDocument({
    title: 'Demo /home/kyle/x',
    startedAt: '2026-10-27T02:00:00.000Z',
    durationMs: 1000,
    video: { fileName: 'a.webm', mimeType: 'video/webm' },
    entries: [
      { atMs: 10, kind: 'note', label: 'see https://example.com/?ticket=abc' },
      { atMs: 'x', kind: 'note', label: 'dropped' },
      { atMs: 20, kind: 'note', label: '   ' },
    ],
  });
  assert.equal(doc.format, PROCEDURE_FORMAT);
  assert.equal(doc.title, 'Demo [path]');
  assert.deepEqual(doc.entries, [{ atMs: 10, kind: 'note', label: 'see [link]' }]);
  assert.deepEqual(doc.video, { fileName: 'a.webm', mimeType: 'video/webm' });
  assert.equal(sanitizeProcedureDocument(null).title, 'Comfyrizz procedure');
});
