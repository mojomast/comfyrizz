import test from 'node:test';
import assert from 'node:assert/strict';
import { renderText, renderJson } from './report.mjs';
import { makeResult } from './checks.mjs';

const fixture = [
  makeResult({ id: 'node', title: 'Node.js', status: 'ok', detail: 'v22.3.0' }),
  makeResult({
    id: 'ffmpeg',
    title: 'ffmpeg',
    status: 'warn',
    detail: 'not found',
    fix: 'install ffmpeg (https://ffmpeg.org/download.html)',
  }),
  makeResult({
    id: 'repo-install',
    title: 'Repo install',
    status: 'fail',
    detail: 'node_modules missing',
    fix: 'pnpm i --frozen-lockfile',
  }),
  makeResult({ id: 'server', title: 'Local server', status: 'skip', detail: 'not running' }),
];

const GOLDEN = [
  '[ok]   Node.js       v22.3.0',
  '[warn] ffmpeg        not found',
  '                     fix: install ffmpeg (https://ffmpeg.org/download.html)',
  '[fail] Repo install  node_modules missing',
  '                     fix: pnpm i --frozen-lockfile',
  '[skip] Local server  not running',
  '',
  'Summary: 1 ok, 1 warn, 1 fail, 1 skip',
].join('\n');

test('golden text for the 4-result fixture', () => {
  assert.equal(renderText(fixture, { color: false }), GOLDEN);
});

test('fix lines appear only for warn and fail, and only when fix is non-empty', () => {
  const text = renderText(fixture, { color: false });
  const fixLines = text.split('\n').filter((line) => line.includes('fix:'));
  assert.equal(fixLines.length, 2);
  assert.ok(text.includes('fix: install ffmpeg (https://ffmpeg.org/download.html)'));
  assert.ok(text.includes('fix: pnpm i --frozen-lockfile'));

  const okWithFix = [
    makeResult({ id: 'a', title: 'A', status: 'ok', detail: 'fine', fix: 'should not print' }),
    makeResult({ id: 'b', title: 'B', status: 'skip', detail: 'nope', fix: 'should not print' }),
  ];
  const clean = renderText(okWithFix, { color: false });
  assert.ok(!clean.includes('fix:'));
  assert.ok(!clean.includes('should not print'));

  const warnNoFix = [
    makeResult({ id: 'c', title: 'C', status: 'warn', detail: 'careful', fix: '' }),
  ];
  assert.equal(renderText(warnNoFix, { color: false }), [
    '[warn] C  careful',
    '',
    'Summary: 0 ok, 1 warn, 0 fail, 0 skip',
  ].join('\n'));
});

test('color:false output is pure ASCII', () => {
  const text = renderText(fixture, { color: false });
  assert.ok(!/[^\x20-\x7e\n]/.test(text), 'non-ASCII characters in color:false output');
});

test('color:true adds ANSI codes and still contains every title', () => {
  const text = renderText(fixture, { color: true });
  assert.ok(text.includes('\u001b['));
  for (const result of fixture) {
    assert.ok(text.includes(result.title), `missing title ${result.title}`);
  }
});

test('empty results render just a summary', () => {
  assert.equal(renderText([], { color: false }), 'Summary: 0 ok, 0 warn, 0 fail, 0 skip');
  assert.equal(renderText(undefined, { color: false }), 'Summary: 0 ok, 0 warn, 0 fail, 0 skip');
});

test('renderJson parses, is stable and has summary.exitCode', () => {
  const parsed = JSON.parse(renderJson(fixture));
  assert.equal(parsed.version, 1);
  assert.equal(parsed.results.length, 4);
  assert.deepEqual(parsed.summary, { ok: 1, warn: 1, fail: 1, skip: 1, exitCode: 1 });
  assert.equal(renderJson(fixture), renderJson(fixture));
  assert.deepEqual(Object.keys(parsed), ['version', 'results', 'summary']);
  assert.deepEqual(Object.keys(parsed.results[0]), ['id', 'title', 'status', 'detail', 'fix']);
});

test('summary.exitCode is 0 without fails and 1 with a fail', () => {
  const noFail = [
    makeResult({ id: 'a', title: 'A', status: 'ok', detail: '' }),
    makeResult({ id: 'b', title: 'B', status: 'warn', detail: '', fix: 'x' }),
    makeResult({ id: 'c', title: 'C', status: 'skip', detail: '' }),
  ];
  assert.equal(JSON.parse(renderJson(noFail)).summary.exitCode, 0);
  assert.equal(JSON.parse(renderJson(fixture)).summary.exitCode, 1);
});

test('output contains no secret-looking values or machine paths', () => {
  const secretPattern = /(sk-[A-Za-z0-9]{8,}|hf_[A-Za-z0-9]{8,}|ghp_[A-Za-z0-9]{8,}|Bearer\s+[A-Za-z0-9])/;
  const homePattern = /(\/home\/|\/workspace\/|C:\\Users|tailnet|ts\.net)/i;
  for (const out of [renderText(fixture, { color: false }), renderJson(fixture)]) {
    assert.ok(!secretPattern.test(out), 'output looks like it contains a secret');
    assert.ok(!homePattern.test(out), 'output contains a machine-specific path');
  }
});
