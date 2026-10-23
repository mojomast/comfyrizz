// IP40R: the pure recovery panel helpers.
//
// The web package typecheck has no @types/node; node:test imports are runtime
// only, like the other web tests that use node:test.
// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isRecoveryConflict,
  recoveryPanelHtml,
  recoveryRequest,
} from '../src/chat-recovery.ts';

const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);

const conflict = { turnId: 'turn-123', projectId: 'pkg_1', expected: 2, found: 3 };

test('isRecoveryConflict recognises a GET conflict body and a POST error body', () => {
  assert.equal(isRecoveryConflict({ conversation: {}, recoveryConflict: conflict }), true);
  assert.equal(isRecoveryConflict({ error: 'RECOVERY_CONFLICT', code: 'RECOVERY_CONFLICT', recoveryConflict: conflict }), true);
  assert.equal(isRecoveryConflict({ code: 'RECOVERY_CONFLICT' }), true);
});

test('isRecoveryConflict is false for ordinary bodies', () => {
  assert.equal(isRecoveryConflict(null), false);
  assert.equal(isRecoveryConflict(undefined), false);
  assert.equal(isRecoveryConflict('RECOVERY_CONFLICT'), false);
  assert.equal(isRecoveryConflict({}), false);
  assert.equal(isRecoveryConflict({ error: 'nope' }), false);
  assert.equal(isRecoveryConflict({ code: 'SOMETHING_ELSE', recoveryConflict: null }), false);
});

test('recoveryPanelHtml offers discard first and escaped text', () => {
  let escapes = 0;
  const spy = value => { escapes += 1; return esc(value); };
  const html = recoveryPanelHtml({ ...conflict, turnId: '<script>alert(1)</script>' }, spy);

  assert.match(html, /role="alertdialog"/);
  assert.match(html, /This conversation needs a decision/);
  assert.match(html, /partly saved/i);
  assert.match(html, /id="chat-recovery-discard"/);
  assert.match(html, /Discard and restore last good save/);
  assert.match(html, /id="chat-recovery-retry"/);
  assert.match(html, /Retry the turn/);
  assert.match(html, /autofocus/);
  assert.match(html, /btn-primary/);
  assert.match(html, /btn-secondary/);
  assert.ok(html.indexOf('chat-recovery-discard') < html.indexOf('chat-recovery-retry'), 'discard is the first button');
  assert.match(html, /takes and generated clips are kept/i);
  assert.ok(escapes > 0, 'the passed esc is used for dynamic text');
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('recoveryRequest builds the exact POST path and body', () => {
  const request = recoveryRequest('discard', { ...conflict, id: 'chat_abc/def ?' });
  assert.equal(request.method, 'POST');
  assert.equal(request.path, '/api/agent/chat/chat_abc%2Fdef%20%3F/recovery');
  assert.deepEqual(request.body, { choice: 'discard', expected: 3 });

  const retry = recoveryRequest('retry', { ...conflict, conversationId: 'chat_plain_0001' });
  assert.equal(retry.path, '/api/agent/chat/chat_plain_0001/recovery');
  assert.deepEqual(retry.body, { choice: 'retry', expected: 3 });
});
