import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyDefaults, loadSchema, validatePackage } from '../src/index.mjs';

const load = (name) => JSON.parse(readFileSync(new URL(`../fixtures/valid/${name}.json`, import.meta.url), 'utf8'));
const lyricPackage = () => load('music-lyrics');
const semantic = (doc) => validatePackage(doc).semantic.map((error) => [error.code, error.path]);

test('old packages and audio defaults remain unchanged when lyric fields are absent', () => {
  const old = load('minimal');
  const before = structuredClone(old);
  const result = validatePackage(old, { defaults: true });
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.deepEqual(old, before, 'validation/defaults must not mutate the input');
  assert.equal('lyricsStyle' in (result.document.audio ?? {}), false);
  assert.equal('lyrics' in (result.document.audio ?? {}), false);

  const audio = load('audio-mix');
  const normalised = applyDefaults(audio, loadSchema());
  assert.equal(normalised.audio.lyricsStyle, undefined);
  assert.equal(normalised.audio.lyrics, undefined);
  assert.equal(validatePackage(audio).valid, true, 'an existing music bed without trim or lyrics stays valid');
});

test('caption and reel accept closed canonical cues and original-song word starts', () => {
  for (const style of ['caption', 'reel']) {
    const doc = lyricPackage();
    doc.audio.lyricsStyle = style;
    const result = validatePackage(doc);
    assert.equal(result.valid, true, JSON.stringify(result.errors));
    assert.equal(doc.audio.lyrics[0].words[0].startSeconds, 0);
    assert.equal('endSeconds' in doc.audio.lyrics[1], false);
  }
});

test('off with no cues is harmless, but non-off needs cues and any cues need master plus trim', () => {
  const off = load('minimal');
  off.audio = { lyricsStyle: 'off', lyrics: [] };
  assert.equal(validatePackage(off).valid, true, JSON.stringify(validatePackage(off).errors));

  const noCues = lyricPackage();
  noCues.audio.lyrics = [];
  assert.deepEqual(semantic(noCues), [['SEM_LYRICS_INVALID', '/audio/lyrics']]);

  const noTrim = lyricPackage();
  delete noTrim.audio.music.trim;
  assert.deepEqual(semantic(noTrim), [['SEM_LYRICS_MUSIC_REQUIRED', '/audio/music/trim']]);

  const noMaster = lyricPackage();
  delete noMaster.audio.music;
  assert.deepEqual(semantic(noMaster), [['SEM_LYRICS_MUSIC_REQUIRED', '/audio/music']]);

  const offWithCues = lyricPackage();
  offWithCues.audio = { lyricsStyle: 'off', lyrics: offWithCues.audio.lyrics };
  assert.deepEqual(semantic(offWithCues), [['SEM_LYRICS_MUSIC_REQUIRED', '/audio/music']]);
});

test('blank text, bad exclusive ends, non-strict starts, and overlap are semantic failures', () => {
  const cases = [
    ['blank cue', (doc) => { doc.audio.lyrics[0].text = '   '; }, '/audio/lyrics/0/text'],
    ['blank word', (doc) => { doc.audio.lyrics[0].words[0].text = ' '; }, '/audio/lyrics/0/words/0/text'],
    ['end equals start', (doc) => { doc.audio.lyrics[0].endSeconds = 0; doc.audio.lyrics[0].words = []; }, '/audio/lyrics/0/endSeconds'],
    ['non-strict cue starts', (doc) => { doc.audio.lyrics = [{ startSeconds: 0, text: 'a' }, { startSeconds: 0, text: 'b' }]; }, '/audio/lyrics/1/startSeconds'],
    ['overlap', (doc) => { doc.audio.lyrics[0].endSeconds = 3; }, '/audio/lyrics/0/endSeconds'],
    ['non-strict word starts', (doc) => { doc.audio.lyrics[0].words[1].startSeconds = 0; }, '/audio/lyrics/0/words/1/startSeconds'],
  ];
  for (const [name, mutate, path] of cases) {
    const doc = lyricPackage();
    mutate(doc);
    assert.deepEqual(semantic(doc), [['SEM_LYRICS_INVALID', path]], name);
  }
});

test('word starts obey explicit and implicit next-cue exclusive boundaries', () => {
  const explicit = lyricPackage();
  explicit.audio.lyrics = [{ startSeconds: 1, endSeconds: 2, text: 'x', words: [{ startSeconds: 2, text: 'outside' }] }];
  assert.deepEqual(semantic(explicit), [['SEM_LYRICS_INVALID', '/audio/lyrics/0/words/0/startSeconds']]);

  const implicit = lyricPackage();
  delete implicit.audio.lyrics[0].endSeconds;
  implicit.audio.lyrics[0].words = [{ startSeconds: 2.5, text: 'belongs to next cue' }];
  assert.deepEqual(semantic(implicit), [['SEM_LYRICS_INVALID', '/audio/lyrics/0/words/0/startSeconds']]);

  const before = lyricPackage();
  before.audio.lyrics[0].words[0].startSeconds = -0.001;
  const result = validatePackage(before);
  assert.equal(result.schemaOk, false, 'negative starts are also structurally bounded');
  assert.ok(result.semantic.some((error) => error.code === 'SEM_LYRICS_INVALID' && error.path === '/audio/lyrics/0/words/0/startSeconds'));
});

test('lyric arrays and cue/word objects are structurally closed and bounded', () => {
  const bad = lyricPackage();
  bad.audio.lyrics[0].extra = true;
  assert.equal(validatePackage(bad).schemaOk, false);
  const badWord = lyricPackage();
  badWord.audio.lyrics[0].words[0].endSeconds = 1;
  assert.equal(validatePackage(badWord).schemaOk, false);
  const missingStart = lyricPackage();
  delete missingStart.audio.lyrics[0].startSeconds;
  assert.equal(validatePackage(missingStart).schemaOk, false);
  const tooLong = lyricPackage();
  tooLong.audio.lyrics[0].text = 'x'.repeat(161);
  assert.equal(validatePackage(tooLong).schemaOk, false);
  const badStyle = lyricPackage();
  badStyle.audio.lyricsStyle = 'scrolling';
  assert.equal(validatePackage(badStyle).schemaOk, false);
});
