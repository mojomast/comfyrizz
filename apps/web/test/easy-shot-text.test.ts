// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';

import { COPY } from '../src/easy/copy.ts';
import { renderShotText, shotTextCommands } from '../src/easy/shot-text.ts';

test('On screen and Narration are labelled and On screen is capped at 80', () => {
  const html = renderShotText({
    id: 'scene-1',
    copy: { headline: 'Crumb & Co sourdough club' },
    narration: 'Fresh bread at your door.',
  });

  const onScreen = html.match(/<label\b[^>]*for="([^"]+)"[^>]*>\s*On screen\s*<\/label>/i);
  const narration = html.match(/<label\b[^>]*for="([^"]+)"[^>]*>\s*Narration\s*<\/label>/i);
  assert.ok(onScreen, 'On screen has a label');
  assert.ok(narration, 'Narration has a label');

  const input = html.match(new RegExp(`<input\\b[^>]*id="${onScreen[1]}"[^>]*>`));
  assert.ok(input, 'the On screen label points at the input');
  assert.match(input[0], /maxlength="80"/);
  assert.match(input[0], /value="Crumb &amp; Co sourdough club"/);

  const textarea = html.match(new RegExp(`<textarea\\b[^>]*id="${narration[1]}"[^>]*>[\\s\\S]*?<\\/textarea>`));
  assert.ok(textarea, 'the Narration label points at the textarea');
  assert.match(textarea[0], /Fresh bread at your door\./);
});

test('both fields escape HTML', () => {
  const html = renderShotText({
    id: 'scene-1',
    copy: { headline: '<script>alert("headline")</script>' },
    narration: '<b>bread</b> & "butter" \'jam\'',
  });

  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<b>bread</b>'));
  assert.ok(html.includes('&lt;script&gt;alert(&quot;headline&quot;)&lt;/script&gt;'));
  assert.ok(html.includes('&lt;b&gt;bread&lt;/b&gt; &amp; &quot;butter&quot; &#39;jam&#39;'));
});

test('the voice note starts hidden and names both parts of the copy', () => {
  const html = renderShotText({ id: 'scene-1', copy: { headline: 'Hello' }, narration: 'Hi' });

  const note = html.match(/<div\b[^>]*data-easy-voice-note[^>]*>/);
  assert.ok(note, 'the voice note host exists');
  assert.match(note[0], /\bhidden\b/);
  assert.ok(html.includes(COPY.review.voiceNeedsUpdate));
  assert.ok(html.includes(COPY.review.remakeVoice));
});

test('shotTextCommands builds the SetSceneCopy command exactly', () => {
  assert.deepEqual(
    shotTextCommands('scene-1', { headline: 'Fresh every morning' }),
    [{ type: 'SetSceneCopy', sceneId: 'scene-1', copy: { headline: 'Fresh every morning' } }],
  );
});

test('shotTextCommands can carry a narration change too', () => {
  assert.deepEqual(
    shotTextCommands('scene-1', { narration: 'We bake at five.' }),
    [{ type: 'SetNarrationText', sceneId: 'scene-1', text: 'We bake at five.' }],
  );
});
