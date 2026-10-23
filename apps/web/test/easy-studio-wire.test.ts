// UR36W: the mounted studio calls approveAndGenerate, then the CPU path.
// The iteration-level gate stays in front of any paid call, and spend-cap
// stays the first step inside approveAndGenerate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const mount = readFileSync(new URL('../src/easy/mount.ts', import.meta.url), 'utf8');
const approve = readFileSync(new URL('../src/easy/approve-generate.ts', import.meta.url), 'utf8');

test('the studio gates paid generation, then approves, then runs the CPU path', () => {
  const start = mount.indexOf('async function approveFromStudio');
  const end = mount.indexOf('function makeCtx');
  const body = mount.slice(start, end);
  assert.ok(start >= 0 && end > start);
  const gate = body.indexOf('iterationBlocksPaidGeneration');
  const approveCall = body.indexOf('approveAndGenerate(');
  const cpuCall = body.indexOf('runCpuFromStudio');
  assert.ok(gate >= 0 && approveCall > gate, 'the iteration-level gate runs before approveAndGenerate');
  assert.ok(cpuCall > approveCall, 'runCpuGenerate runs after approveAndGenerate');
  assert.match(mount, /runCpuGenerate\(/);
  assert.match(body, /compute === 'cpu'/);
});

test('spend-cap stays ahead of plan approval inside approveAndGenerate', () => {
  const bodyStart = approve.indexOf('async function approveBody');
  const bodyEnd = approve.indexOf('export async function approveAndGenerate');
  const body = approve.slice(bodyStart, bodyEnd);
  const cap = body.indexOf('setSpendCap');
  const approval = body.indexOf('sendPlanApproval');
  const dispatch = body.indexOf('dispatchAction');
  const run = body.indexOf('startRun');
  assert.ok(cap >= 0 && approval > cap && dispatch > approval && run > dispatch);
});
