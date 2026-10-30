// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import { COPY } from '../src/easy/copy.ts';
import { COMPUTE_HF_NOT_READY, renderCompute, validateCap, computeBlockReason } from '../src/easy/compute-choice.ts';

const signedIn = { signedIn: true, installed: true, tokenPresent: true, tokenChecked: true, tokenReady: true };

function inputTag(html, id) {
  const match = html.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`));
  return match ? match[0] : '';
}

function radioTag(html, value) {
  const match = html.match(new RegExp(`<input[^>]*value="${value}"[^>]*>`));
  return match ? match[0] : '';
}

test('validateCap rejects values outside 0.5 to 500 in half-unit steps', () => {
  for (const value of [0, 0.3, 501, 'abc', 1.25, '', null, undefined]) {
    assert.equal(validateCap(value), COPY.compute.capError, `expected ${JSON.stringify(value)} to be rejected`);
  }
});

test('validateCap accepts 0.5, 15 and 500', () => {
  for (const value of [0.5, 15, 500, '0.5', '15', '500']) {
    assert.equal(validateCap(value), null, `expected ${JSON.stringify(value)} to be accepted`);
  }
});

test('an empty default cap blocks paid work until the user sets one', () => {
  const html = renderCompute({ compute: 'colab', colabStatus: signedIn, spendCap: null, spent: 0 });
  const tag = inputTag(html, 'easy-cap');
  assert.ok(tag, 'the cap input should render');
  assert.ok(!/\svalue=/.test(tag) || /\svalue=""/.test(tag), 'the cap input must start empty');
  assert.doesNotMatch(html, /value="15"/);
  assert.equal(computeBlockReason({ compute: 'colab', spendCap: null }, signedIn), COPY.compute.capError);
  assert.equal(computeBlockReason({ compute: 'colab', spendCap: undefined }, signedIn), COPY.compute.capError);
  assert.equal(computeBlockReason({ compute: 'colab', spendCap: '' }, signedIn), COPY.compute.capError);
});

test('Google Colab is disabled when not signed in', () => {
  const html = renderCompute({ compute: 'cpu', colabStatus: { signedIn: false }, spendCap: 15, spent: 0 });
  assert.match(radioTag(html, 'colab'), /\sdisabled(?=[\s/>])/);
  assert.ok(html.includes(COPY.compute.notConnected));
  assert.match(html, /<button[^>]*data-easy-compute-connect[^>]*>Connect<\/button>/);
  assert.doesNotMatch(radioTag(html, 'cpu'), /\sdisabled(?=[\s/>])/);
});

test('the checking state is explicit and does not offer Connect yet', () => {
  const html = renderCompute({ compute: 'cpu', colabStatus: null, spendCap: 15, spent: 0, checking: true });
  assert.ok(html.includes(COPY.compute.checking));
  assert.ok(!html.includes(COPY.compute.notConnected));
  assert.doesNotMatch(html, /data-easy-compute-connect/);
  const colab = radioTag(html, 'colab');
  assert.doesNotMatch(colab, /\sdisabled(?=[\s/>])/);
  assert.match(colab, /aria-describedby="easy-not-connected"/);
});

test('Google Colab is enabled only when signed in and both HF checks passed', () => {
  const html = renderCompute({ compute: 'cpu', colabStatus: signedIn, spendCap: 15, spent: 0 });
  assert.doesNotMatch(radioTag(html, 'colab'), /\sdisabled(?=[\s/>])/);
  assert.ok(!html.includes(COPY.compute.notConnected));

  for (const colabStatus of [
    { signedIn: true, installed: true },
    { signedIn: true, installed: true, tokenPresent: true, tokenChecked: false, tokenReady: false },
    { signedIn: true, installed: true, tokenPresent: true, tokenChecked: false, tokenReady: true },
    { signedIn: true, installed: true, tokenPresent: true, tokenChecked: true, tokenReady: false },
  ]) {
    const blocked = renderCompute({ compute: 'cpu', colabStatus, spendCap: 15, spent: 0 });
    assert.match(radioTag(blocked, 'colab'), /\sdisabled(?=[\s/>])/);
    assert.match(blocked, /Hugging Face model access is not verified/);
    assert.match(blocked, /data-easy-compute-connect/);
  }
  assert.equal(
    computeBlockReason({ compute: 'colab', spendCap: 15 }, { signedIn: true, tokenPresent: true, tokenReady: true }),
    COMPUTE_HF_NOT_READY,
  );
});

test('the cap input exists only when compute is Google Colab', () => {
  const cpu = renderCompute({ compute: 'cpu', colabStatus: signedIn, spendCap: 15, spent: 0 });
  assert.ok(!cpu.includes('id="easy-cap"'));
  assert.ok(!cpu.includes('easy-cap'));

  const colab = renderCompute({ compute: 'colab', colabStatus: signedIn, spendCap: 15, spent: 0 });
  const tag = inputTag(colab, 'easy-cap');
  assert.ok(tag, 'the cap input should exist');
  assert.match(colab, /<label[^>]*for="easy-cap"/);
  assert.match(tag, /type="number"/);
  assert.match(tag, /min="0\.5"/);
  assert.match(tag, /max="500"/);
  assert.match(tag, /step="0\.5"/);
  assert.match(tag, /inputmode="decimal"/);
  assert.match(tag, /value="15"/);
  assert.ok(colab.includes('So far: 0 units.'));
});

test('the copy says Google Colab units and never GPU units', () => {
  const cpu = renderCompute({ compute: 'cpu', colabStatus: signedIn, spendCap: null, spent: 0 });
  const colab = renderCompute({ compute: 'colab', colabStatus: signedIn, spendCap: 15, spent: 4.4 });
  for (const html of [cpu, colab]) {
    assert.match(html, /Google Colab units/);
    assert.doesNotMatch(html, /GPU units/i);
  }
  assert.ok(colab.includes('So far: 4.4 units.'));
});

test('computeBlockReason reports connection before a missing cap', () => {
  assert.equal(computeBlockReason({ compute: 'cpu', spendCap: null }, { signedIn: false }), null);
  assert.equal(
    computeBlockReason({ compute: 'colab', spendCap: null }, { signedIn: false }),
    COPY.compute.blockNotConnected,
  );
  assert.equal(computeBlockReason({ compute: 'colab', spendCap: 15 }, signedIn), null);
  assert.equal(computeBlockReason({ compute: 'colab', spendCap: 1.25 }, signedIn), COPY.compute.capError);
});
