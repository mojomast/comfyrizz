import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseLrc } from '../../../packages/planner/dist/src/index.js';
import { validatePackage } from '../../../packages/schema/src/index.mjs';
import { createCpuAgentRunner } from '../src/agent-runner.mjs';
import {
  adoptMusicVideoAttachments,
  lyricCuesOverlapTrim,
} from '../src/music-video.mjs';
import { planPipeline } from '../src/pipeline-contract.mjs';
import { prepareRunNarration, runNeedsNarration } from '../src/run-narration.mjs';
import { createReferenceStore } from '../src/references/store.mjs';

const CHAT = 'chat_musicvideo_lyrics';
const BRIEF = 'Draw a labeled process with SVG diagrams.';

function wavSeconds(seconds) {
  const samples = Math.round(seconds * 24_000);
  const data = Buffer.alloc(samples * 2);
  const wav = Buffer.alloc(44 + data.length);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(24_000, 24);
  wav.writeUInt32LE(48_000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(data.length, 40);
  data.copy(wav, 44);
  return wav;
}

function makePackage() {
  return {
    $schema: 'https://comfyrizz.example/schema/package-v1.json',
    schemaVersion: 1,
    revision: 1,
    id: 'pkg_musicvideo_lyrics',
    title: 'Music video lyrics test',
    createdAt: '2026-10-28T00:00:00.000Z',
    format: { width: 1920, height: 1080, fps: 30 },
    duration: { mode: 'target', targetFrames: 240 },
    voice: { enabled: true, engine: 'kokoro', voice: 'af_heart' },
    scenes: [
      {
        id: 's1', layout: 'hero', preferredFrames: 120,
        copy: { headline: 'First section' },
        background: { procedural: { pattern: 'gradient', palette: ['#0d0f14', '#6d8cff'] } },
        narration: 'Stale narration must not be synthesized.',
        transitionOut: { type: 'fade', frames: 15 },
      },
      {
        id: 's2', layout: 'hero', preferredFrames: 120,
        copy: { headline: 'Second section' },
        background: { procedural: { pattern: 'dots', seed: 2 } },
        narration: 'More stale narration.',
        transitionOut: { type: 'fade', frames: 15 },
      },
    ],
    assets: {},
    compliance: { open_weights_only: true, backends_used: [] },
  };
}

function songRuntime(t, durationSec = 20) {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'comfyrizz-music-lyrics-'));
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  const references = createReferenceStore({ rootDir: runtimeDir, chatId: CHAT });
  const song = references.add({
    bytes: wavSeconds(durationSec),
    filename: 'song.wav',
    meta: { mime: 'audio/wav', role: 'song', durationSec, codec: 'pcm_s16le', sampleRate: 24_000, channels: 1 },
  });
  references.update(song.id, { usage: 'editorial' });
  return runtimeDir;
}

async function adopt(runtimeDir, options = {}) {
  return adoptMusicVideoAttachments({
    runtimeDir,
    conversationId: CHAT,
    package: makePackage(),
    requestedSeconds: 12,
    ffprobeExec: async () => ({
      stdout: JSON.stringify({
        streams: [{ codec_name: 'pcm_s16le', sample_rate: '24000', channels: 1, duration: '20' }],
        format: { duration: '20' },
      }),
    }),
    ...options,
  });
}

test('caption and reel adoption preserve exact enhanced text, escaping and untrimmed cue times', async t => {
  const lrc = [
    '[ar:Exact & untouched]',
    '[00:04.000]  [Chorus] <b>A&B "quoted" \\ path</b>  ',
    '[00:05.500]prefix <00:05.500>Hello & <00:06.000><i>world</i>!',
  ].join('\n');
  const canonical = parseLrc(lrc);
  for (const lyricsStyle of ['caption', 'reel']) {
    const runtimeDir = songRuntime(t);
    const source = makePackage();
    const { package: adopted, song } = await adopt(runtimeDir, {
      package: source,
      songTrim: { startSeconds: 4, endSeconds: 12 },
      lyricsStyle,
      lyrics: canonical,
    });
    assert.equal(adopted.audio.lyricsStyle, lyricsStyle);
    assert.deepEqual(adopted.audio.lyrics, canonical);
    assert.deepEqual(JSON.parse(JSON.stringify(adopted.audio.lyrics)), canonical);
    assert.deepEqual(adopted.audio.lyrics.map(cue => cue.startSeconds), [4, 5.5]);
    assert.equal(adopted.audio.lyrics[0].text, '  [Chorus] <b>A&B "quoted" \\ path</b>  ');
    assert.equal(adopted.audio.lyrics[1].text, 'prefix Hello & <i>world</i>!');
    assert.deepEqual(adopted.audio.lyrics[1].words, [
      { startSeconds: 5.5, text: 'Hello & ' },
      { startSeconds: 6, text: '<i>world</i>!' },
    ]);
    assert.deepEqual(adopted.audio.music.trim, { startSeconds: 4, endSeconds: 12 });
    assert.equal(song.trimmedDurationSeconds, 8);
    assert.equal(adopted.voice.enabled, false);
    assert.ok(adopted.scenes.every(scene => !scene.narration && !scene.narration_asset));
    assert.equal(source.audio, undefined, 'adoption does not write cues into the draft input');
    assert.equal(validatePackage(adopted).valid, true, JSON.stringify(validatePackage(adopted).errors));
  }
});

test('off retains valid cues for editing, while off plus no cues omits both lyric fields', async t => {
  const outside = [{ startSeconds: 19, text: 'Keep for a later trim' }];
  const withCues = await adopt(songRuntime(t), {
    songTrim: { startSeconds: 4, endSeconds: 12 }, lyricsStyle: 'off', lyrics: outside,
  });
  assert.equal(withCues.package.audio.lyricsStyle, 'off');
  assert.deepEqual(withCues.package.audio.lyrics, outside);
  assert.equal(validatePackage(withCues.package).valid, true);

  for (const options of [{}, { lyricsStyle: 'off' }, { lyricsStyle: 'off', lyrics: [] }]) {
    const empty = await adopt(songRuntime(t), options);
    assert.equal('lyricsStyle' in empty.package.audio, false);
    assert.equal('lyrics' in empty.package.audio, false);
  }
});

test('trim overlap uses half-open boundaries and implicit next-cue ends without shifting cues', async t => {
  const trim = { startSeconds: 5, endSeconds: 10 };
  assert.equal(lyricCuesOverlapTrim([{ startSeconds: 10, text: 'exclusive end' }], trim), false);
  assert.equal(lyricCuesOverlapTrim([{ startSeconds: 4, endSeconds: 5, text: 'exclusive start' }], trim), false);
  assert.equal(lyricCuesOverlapTrim([{ startSeconds: 4, endSeconds: 5.001, text: 'crosses start' }], trim), true);
  assert.equal(lyricCuesOverlapTrim([{ startSeconds: 5, text: 'at start' }], trim), true);
  assert.equal(lyricCuesOverlapTrim([{ startSeconds: 4, text: 'continues into trim' }], trim), true);
  assert.equal(lyricCuesOverlapTrim([
    { startSeconds: 0, text: 'before' },
    { startSeconds: 5, text: 'boundary' },
  ], { startSeconds: 0, endSeconds: 5 }), true);
  assert.equal(lyricCuesOverlapTrim([], trim), false);

  await assert.rejects(
    adopt(songRuntime(t), {
      songTrim: { startSeconds: 4, endSeconds: 12 },
      lyricsStyle: 'caption',
      lyrics: [{ startSeconds: 12, text: 'starts at exclusive trim end' }],
    }),
    error => error?.code === 'LYRICS_OUTSIDE_TRIM' && error?.status === 422,
  );
  await assert.rejects(
    adopt(songRuntime(t), { lyricsStyle: 'reel', lyrics: [] }),
    error => error?.code === 'LYRICS_OUTSIDE_TRIM',
  );
});

test('runner rejects an empty effective lyric window before provider resolution or model work', async t => {
  const runtimeDir = songRuntime(t, 12);
  let providerCalls = 0;
  const runner = createCpuAgentRunner({
    runtimeDir,
    resolveProviderConfig: () => { providerCalls += 1; throw new Error('provider must not be resolved'); },
  });
  const base = {
    brief: `${BRIEF}\nLength: about 8 seconds.`,
    videoType: 'music-video',
    conversationId: CHAT,
    provider: 'openrouter',
    songTrim: { startSeconds: 4, endSeconds: 8 },
    lyricsStyle: 'caption',
  };
  for (const lyrics of [
    [{ startSeconds: 0, endSeconds: 4, text: 'ends at trim start' }],
    [{ startSeconds: 8, text: 'starts at trim end' }],
    [],
  ]) {
    await assert.rejects(
      runner({ ...base, lyrics }),
      error => error?.code === 'LYRICS_OUTSIDE_TRIM' && error?.status === 422,
    );
  }
  assert.equal(providerCalls, 0);
  await assert.rejects(
    runner({ ...base, lyricsStyle: null, lyrics: [] }),
    error => error?.code === 'INVALID_LYRICS_STYLE' && error?.status === 400,
  );
  await assert.rejects(
    runner({ brief: BRIEF, videoType: 'sketch-build', lyricsStyle: 'off', lyrics: [] }),
    error => error?.code === 'INVALID_MUSIC_OPTIONS' && error?.status === 400,
  );
  assert.equal(providerCalls, 0);
});

test('master-song guards suppress stale Kokoro/Qwen narration but leave old nonmusic packages voiced', async t => {
  const { package: adopted } = await adopt(songRuntime(t), {
    songTrim: { startSeconds: 4, endSeconds: 12 },
    lyricsStyle: 'reel',
    lyrics: [{ startSeconds: 4, text: 'Lyrics are not narration' }],
  });
  assert.equal(adopted.assets.a_narration, undefined);
  assert.ok(adopted.scenes.every(scene => !scene.narration));
  adopted.voice = { enabled: true, engine: 'qwen3-tts', strict: true, voice: 'stale-speaker' };
  adopted.scenes[0].narration = 'A stale field reappeared.';
  assert.equal(runNeedsNarration(adopted), false);
  let synthesisCalls = 0;
  const prepared = await prepareRunNarration({
    pkg: adopted,
    workDir: '/unused/work',
    outputDir: '/unused/out',
    packageDir: '/unused/package',
    runCommand: async () => { synthesisCalls += 1; },
  });
  assert.deepEqual(prepared, { voiced: false });
  assert.equal(synthesisCalls, 0);
  const plan = planPipeline(adopted, { backendId: 'cpu', narrationRuntime: 'colab' });
  assert.equal(plan.voiced, false);
  assert.equal(plan.remoteVoice, false);
  assert.equal(plan.requiresAudio, true, 'the master song still requires final audio verification');
  assert.equal(plan.budget.narrationCeilingUnits, 0);

  const oldNonmusic = makePackage();
  delete oldNonmusic.scenes.at(-1).transitionOut;
  assert.equal(runNeedsNarration(oldNonmusic), true);
  assert.equal(planPipeline(oldNonmusic, { backendId: 'cpu' }).voiced, true);
});
