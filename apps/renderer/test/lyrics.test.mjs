import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  activeLyricAt,
  clipLyricCues,
  lyricAtFrame,
  lyricSongTime,
  lyricTextSegments,
  lyricWordPopProgress,
  lyricWordPopScale,
  lyricsLayout,
  normalizeLyricsStyle,
} from '../src/lyrics-model.js';
import { resolvePackageComposition } from '../src/composition-model.js';
import { planSegments, RENDERER_VERSION } from '../scripts/render-incremental.mjs';

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test('trim clipping handles in/out/cross-boundary and empty-after-trim cues', () => {
  const trim = { startSeconds: 10, endSeconds: 15 };
  const cues = clipLyricCues([
    { startSeconds: 8, endSeconds: 10, text: 'ends at trim start' },
    { startSeconds: 9, endSeconds: 11, text: 'crosses in' },
    { startSeconds: 11, endSeconds: 12, text: 'inside' },
    { startSeconds: 14, endSeconds: 16, text: 'crosses out' },
    { startSeconds: 15, endSeconds: 16, text: 'starts at trim end' },
  ], trim);
  assert.deepEqual(cues.map(cue => [cue.text, cue.startSeconds, cue.endSeconds]), [
    ['crosses in', 10, 11],
    ['inside', 11, 12],
    ['crosses out', 14, 15],
  ]);
  assert.equal(activeLyricAt(cues, 10).cue.text, 'crosses in');
  assert.equal(activeLyricAt(cues, 10.999).cue.text, 'crosses in');
  assert.equal(activeLyricAt(cues, 11).cue.text, 'inside');
  assert.equal(activeLyricAt(cues, 12).cue, null);
  assert.equal(activeLyricAt(cues, 15).cue, null, 'trim end is exclusive');
  assert.deepEqual(clipLyricCues([{ startSeconds: 20, text: 'after' }], trim), []);
  assert.deepEqual(clipLyricCues([{ startSeconds: 1, endSeconds: 2, text: 'before' }], trim), []);
});

test('adjacent cues are half-open, explicit gaps stay empty, and the final cue reaches trim end', () => {
  const trim = { startSeconds: 10.25, endSeconds: 14.75 };
  const cues = clipLyricCues([
    { startSeconds: 10, endSeconds: 10.5, text: 'cross in' },
    { startSeconds: 10.5, text: 'adjacent' },
    { startSeconds: 11.5, endSeconds: 11.75, text: 'short' },
    { startSeconds: 12.25, text: 'after gap' },
    { startSeconds: 13.5, text: 'final' },
  ], trim);
  assert.deepEqual(cues.map(cue => [cue.text, cue.startSeconds, cue.endSeconds]), [
    ['cross in', 10.25, 10.5],
    ['adjacent', 10.5, 11.5],
    ['short', 11.5, 11.75],
    ['after gap', 12.25, 13.5],
    ['final', 13.5, 14.75],
  ]);
  assert.equal(activeLyricAt(cues, 10.5).cue.text, 'adjacent');
  assert.equal(activeLyricAt(cues, 11.75).cue, null);
  assert.equal(activeLyricAt(cues, 12.249).cue, null);
  assert.equal(activeLyricAt(cues, 12.25).cue.text, 'after gap');
  assert.equal(activeLyricAt(cues, 14.749).cue.text, 'final');
  assert.equal(activeLyricAt(cues, 14.75).cue, null);
});

test('enhanced cues preserve untimed prefixes and gaps without inventing word starts', () => {
  const text = '  <b>שָׁלוֹם</b>  Hello  world!';
  const [cue] = clipLyricCues([{
    startSeconds: 20,
    endSeconds: 22,
    text,
    words: [
      { startSeconds: 20.5, text: 'Hello  ' },
      { startSeconds: 21.25, text: 'world!' },
    ],
  }], { startSeconds: 20, endSeconds: 22 });
  assert.equal(cue.words[0].endSeconds, 21.25, 'word end is the next real word start');
  assert.equal(cue.words[1].endSeconds, 22, 'final word end is its containing cue end');
  assert.equal(activeLyricAt([cue], 20.25).cue, cue);
  assert.equal(activeLyricAt([cue], 20.25).wordIndex, -1, 'prefix has no synthetic word timing');
  assert.equal(activeLyricAt([cue], 20.5).word.text, 'Hello  ');
  assert.equal(activeLyricAt([cue], 21.25).word.text, 'world!');
  assert.equal(activeLyricAt([cue], 22).cue, null);
  const segments = lyricTextSegments(cue);
  assert.equal(segments.map(segment => segment.text).join(''), text);
  assert.equal(segments[0].wordIndex, -1);
  assert.match(segments[0].text, /<b>שָׁלוֹם<\/b>/);

  const enhancedWithGap = clipLyricCues([
    { startSeconds: 1, endSeconds: 1.2, text: 'a', words: [{ startSeconds: 1, text: 'a' }] },
    { startSeconds: 1.5, endSeconds: 2, text: 'b', words: [{ startSeconds: 1.5, text: 'b' }] },
  ], { startSeconds: 1, endSeconds: 2 });
  assert.equal(activeLyricAt(enhancedWithGap, 1.3).wordIndex, -1, 'a real enhanced gap is not filled');
  assert.equal(activeLyricAt(enhancedWithGap, 1.3).cue, null, 'the explicit cue gap stays empty');
  assert.equal(activeLyricAt(enhancedWithGap, 1.5).word.text, 'b');
});

test('standard LRC lines never gain synthesized words, even in reel-style timing lookups', () => {
  const [cue] = clipLyricCues([{ startSeconds: 1, text: '  literal <i>line</i>  ' }], { startSeconds: 0, endSeconds: 3 });
  assert.equal('words' in cue, false);
  assert.deepEqual(lyricTextSegments(cue), [{ text: '  literal <i>line</i>  ', wordIndex: -1 }]);
  const active = activeLyricAt([cue], 1.5);
  assert.equal(active.cue, cue);
  assert.equal(active.word, null);
  assert.equal(active.wordIndex, -1);
});

test('lyric components use literal React children, bidi auto direction and passive accessibility', () => {
  const source = readFileSync(new URL('../src/lyrics.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /dangerouslySetInnerHTML/);
  assert.match(source, /dir="auto"/);
  assert.match(source, /aria-live="off"/);
  assert.match(source, /pointerEvents:\s*'none'/);
  assert.match(source, /!reducedMotion/, 'reduced motion suppresses the word transform');
});

test('24/30/60fps and fractional trims use the same unrounded source clock', () => {
  const startSeconds = 7.03125;
  for (const fps of [24, 30, 60]) {
    const trim = { startSeconds, endSeconds: startSeconds + 1 };
    const cueStart = startSeconds + 3 / fps;
    const cueEnd = startSeconds + 8 / fps;
    const cues = clipLyricCues([{ startSeconds: cueStart, endSeconds: cueEnd, text: `${fps}fps` }], trim);
    close(lyricSongTime(3, fps, trim), cueStart);
    assert.equal(lyricAtFrame({ cues, trim, frame: 2, fps }).cue, null, `${fps}: before start`);
    assert.equal(lyricAtFrame({ cues, trim, frame: 3, fps }).cue?.text, `${fps}fps`, `${fps}: inclusive start`);
    assert.equal(lyricAtFrame({ cues, trim, frame: 7, fps }).cue?.text, `${fps}fps`);
    assert.equal(lyricAtFrame({ cues, trim, frame: 8, fps }).cue, null, `${fps}: exclusive end`);
  }
});

test('positive subframe cues are not forced onto a frame', () => {
  const trim = { startSeconds: 4, endSeconds: 5 };
  const cues = clipLyricCues([{ startSeconds: 4.001, endSeconds: 4.002, text: 'tiny' }], trim);
  assert.equal(cues.length, 1, 'the canonical cue survives clipping');
  assert.equal(lyricAtFrame({ cues, trim, frame: 0, fps: 60 }).cue, null);
  assert.equal(lyricAtFrame({ cues, trim, frame: 1, fps: 60 }).cue, null);
});

test('responsive safe areas, reactive-card avoidance and reduced-motion values are pure', () => {
  for (const [width, height] of [[1920, 1080], [1080, 1920], [640, 360], [360, 640]]) {
    const layout = lyricsLayout({ width, height, avoidReactiveCard: true });
    assert.ok(layout.safeArea.x >= 16 && layout.safeArea.x * 2 < width);
    assert.ok(layout.safeArea.y >= 16 && layout.safeArea.y * 2 < height);
    assert.equal(layout.caption.maxWidth, width - layout.safeArea.x * 2);
    assert.equal(layout.reel.maxWidth, width - layout.safeArea.x * 2);
    assert.ok(layout.caption.bottom > layout.safeArea.y, 'caption is above the bottom-right reactive card');
    assert.ok(layout.reel.bottom > layout.caption.bottom, 'reel reserves the bottom caption zone');
    assert.ok(layout.reel.fontSize > layout.caption.fontSize);
    assert.ok(layout.reel.top < height - layout.reel.bottom);
  }
  const normal = lyricsLayout({ width: 1920, height: 1080 });
  const reduced = lyricsLayout({ width: 1920, height: 1080, reducedMotion: true });
  assert.equal(normal.motion.pop, true);
  assert.equal(reduced.motion.pop, false);
  assert.equal(reduced.motion.popSeconds, 0);
  assert.equal(reduced.motion.popScale, 1);
  assert.equal(lyricWordPopScale(0, true), 1);
  assert.ok(lyricWordPopScale(0, false) > 1);
  assert.equal(lyricWordPopProgress({ startSeconds: 4, sourceStartSeconds: 3.8 }, 4, false), 1, 'no new pop at trim start');
  assert.equal(normalizeLyricsStyle('reel'), 'reel');
  assert.equal(normalizeLyricsStyle(undefined), 'off');
});

const timeline = {
  fps: 30,
  width: 640,
  height: 360,
  durationInFrames: 60,
  captions: [{ text: 'stale narration', from: 0, to: 30, estimated: false }],
  scenes: [{ id: 's1', layout: 'title', from: 0, durationInFrames: 60, transitionOutFrames: 0 }],
};

function compositionPackage() {
  return {
    audio: {
      lyricsStyle: 'caption',
      lyrics: [{ startSeconds: 10.25, text: 'song words' }],
      music: { asset: 'a_song', trim: { startSeconds: 10, endSeconds: 12 } },
    },
    assets: {
      a_song: { kind: 'audio', status: 'ready', file: 'audio/song.wav' },
      a_voice: { kind: 'audio', status: 'ready', file: 'audio/voice.wav' },
    },
    scenes: [{ id: 's1', layout: 'title', copy: { headline: 'Picture' }, narration_asset: 'a_voice' }],
  };
}

test('master lyrics replace stale narration captions; mixAudio:false preserves legacy behavior', () => {
  const pkg = compositionPackage();
  const resolved = resolvePackageComposition(pkg, timeline);
  assert.equal(resolved.narration, null);
  assert.equal(resolved.captions, null);
  assert.equal(resolved.lyrics.style, 'caption');
  assert.equal(resolved.lyrics.cues.length, 1);
  assert.equal(resolved.lyrics.cues[0].endSeconds, 12);
  assert.equal(lyricAtFrame({ ...resolved.lyrics, frame: 8, fps: 30 }).cue.text, 'song words');

  const legacy = resolvePackageComposition(pkg, timeline, { mixAudio: false });
  assert.ok(legacy.narration);
  assert.equal(legacy.captions, timeline.captions);
  assert.equal(legacy.lyrics, null);
});

test('incremental picture keys/version include lyric style, cues and trim', () => {
  assert.ok(RENDERER_VERSION >= 10);
  const pkg = compositionPackage();
  const base = planSegments(pkg, timeline);
  assert.deepEqual(planSegments(pkg, timeline).map(segment => segment.key), base.map(segment => segment.key));
  for (const mutate of [
    draft => { draft.audio.lyricsStyle = 'reel'; },
    draft => { draft.audio.lyrics[0].text = 'edited song words'; },
    draft => { draft.audio.lyrics[0].startSeconds += 0.01; },
    draft => { draft.audio.music.trim.startSeconds += 0.01; },
  ]) {
    const edited = structuredClone(pkg);
    mutate(edited);
    assert.notDeepEqual(planSegments(edited, timeline).map(segment => segment.key), base.map(segment => segment.key));
  }
});
