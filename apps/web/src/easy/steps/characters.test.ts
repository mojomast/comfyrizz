// EX11: the narration row is one control with a visible On/Off state.
//
// node:test imports are runtime-only, so type checking is skipped like the
// other Easy render tests.
// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';

import { renderNarration } from './characters.ts';

function count(html, pattern) {
  return (html.match(pattern) ?? []).length;
}

if (typeof window === 'undefined') {
  test('narration renders one switch with a visible On state and its accessible name', () => {
    const html = renderNarration({ narration: { on: true, voiceId: null } });
    assert.equal(count(html, /data-easy-narration(?=[\s>])/g), 1);
    assert.equal(count(html, /type="checkbox"/g), 1);
    assert.equal(count(html, /role="switch"/g), 1);
    assert.match(html, /aria-label="Narration"/);
    assert.match(html, /aria-checked="true"/);
    assert.match(html, /data-easy-narration-state[^>]*>On</);
    assert.match(html, /checked/);
    assert.match(html, />Narration</);
  });

  test('narration shows the Off state when it is turned off', () => {
    const html = renderNarration({ narration: { on: false, voiceId: null } });
    assert.equal(count(html, /data-easy-narration(?=[\s>])/g), 1);
    assert.match(html, /aria-label="Narration"/);
    assert.match(html, /aria-checked="false"/);
    assert.match(html, /data-easy-narration-state[^>]*>Off</);
    assert.doesNotMatch(html, /\schecked(?=[\s/>])/);
  });
}
