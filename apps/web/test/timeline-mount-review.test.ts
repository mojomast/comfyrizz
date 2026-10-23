// IP32: the timeline host must forward review callbacks, not swallow them.
// The web package has no DOM harness and Node cannot import a .tsx module, so
// this test pins the wiring in the host adapter and exercises the shared clip
// key helper the timeline uses for its keyboard review shortcuts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { clipKeyboardAction } from '../src/editor/timeline/clip-state.ts';

const MOUNT = readFileSync(new URL('../src/editor/timeline/mount.tsx', import.meta.url), 'utf8');
const TIMELINE = readFileSync(new URL('../src/editor/timeline/Timeline.tsx', import.meta.url), 'utf8');

test('mount forwards select, cycle and approve review callbacks to the timeline', () => {
  assert.match(MOUNT, /onClipSelect\?:\s*\(chip:\s*ClipChip\)\s*=>\s*void/);
  assert.match(MOUNT, /onClipCycle\?:\s*\(chip:\s*ClipChip,\s*delta:\s*-1\s*\|\s*1\)\s*=>\s*void/);
  assert.match(MOUNT, /onClipApprove\?:\s*\(chip:\s*ClipChip\)\s*=>\s*void/);
  assert.match(MOUNT, /onClipSelect=\{hooks\.onClipSelect\}/);
  assert.match(MOUNT, /onClipCycle=\{hooks\.onClipCycle\}/);
  assert.match(MOUNT, /onClipApprove=\{hooks\.onClipApprove\}/);
});

test('the existing document, seek, play and clips hooks survive the adapter', () => {
  assert.match(MOUNT, /onDocument:\s*\(pkg:\s*PackageV1,\s*timeline:\s*CompiledTimeline\)\s*=>\s*void/);
  assert.match(MOUNT, /seek:\s*\(frame:\s*number\)\s*=>\s*void/);
  assert.match(MOUNT, /togglePlay:\s*\(\)\s*=>\s*void/);
  assert.match(MOUNT, /clips\?:\s*\{/);
  assert.match(MOUNT, /onSeek=\{hooks\.seek\}/);
  assert.match(MOUNT, /onTogglePlay=\{hooks\.togglePlay\}/);
  assert.match(MOUNT, /clips=\{hooks\.clips\?\.all\(\)\}/);
});

test('focused-chip keyboard shortcuts resolve to the forwarded review actions', () => {
  const base = { meta: false, ctrl: false, shift: false, alt: false, typing: false, onButton: false };
  assert.deepEqual(clipKeyboardAction({ ...base, key: 'a' }), { type: 'approve' });
  assert.deepEqual(clipKeyboardAction({ ...base, key: 'A', shift: true }), { type: 'approve' });
  assert.deepEqual(clipKeyboardAction({ ...base, key: '[' }), { type: 'prev-take' });
  assert.deepEqual(clipKeyboardAction({ ...base, key: ']' }), { type: 'next-take' });
  assert.equal(clipKeyboardAction({ ...base, key: 'a', typing: true }), null);
  assert.equal(clipKeyboardAction({ ...base, key: 'a', meta: true }), null);

  assert.match(TIMELINE, /clipKeyboardAction\(\{/);
  assert.match(TIMELINE, /clipAction\?\.type === 'approve' && onClipApprove/);
  assert.match(TIMELINE, /onClipApprove\(focusedChip\)/);
  assert.match(TIMELINE, /onClipCycle\(focusedChip, delta\)/);
});

test('a chip click selects through the forwarded handler', () => {
  assert.match(TIMELINE, /onClick=\{event => \{/);
  assert.match(TIMELINE, /onClipSelect\?\.\(chip\)/);
  assert.match(MOUNT, /onClipSelect=\{hooks\.onClipSelect\}/);
});
