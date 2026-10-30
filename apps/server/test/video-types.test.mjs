import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createCpuAgentRunner } from '../src/agent-runner.mjs';
import { createApp } from '../src/app.mjs';
import { createReferenceStore } from '../src/references/store.mjs';
import { validatePackage } from '../../../packages/schema/src/index.mjs';

const TOKEN = 'video-types-test-token';
const BRIEF = 'Draw a labeled process with SVG diagrams.';
const OFFLINE_BRIEF = 'Create a labeled product walkthrough.';
const CHAT = 'chat_0123456789abcdef';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082', 'hex');

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

async function postAgent(port, body) {
  const response = await fetch(`http://127.0.0.1:${port}/api/agent`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: `http://127.0.0.1:${port}`,
      'x-comfyrizz-token': TOKEN,
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test('POST /api/agent validates videoType before the runner and forwards optional context without changing omitted shapes', async t => {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'comfyrizz-video-types-http-'));
  const calls = [];
  const app = createApp({
    root: new URL('../../..', import.meta.url).pathname,
    token: TOKEN,
    runtimeDir,
    agentRunner: async args => {
      calls.push(args);
      throw Object.assign(new Error('runner capture complete'), { status: 400 });
    },
  });
  const server = createServer(app.handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(async () => {
    app.close();
    await new Promise(resolve => server.close(resolve));
    rmSync(runtimeDir, { recursive: true, force: true });
  });

  const unknown = await postAgent(port, { brief: BRIEF, videoType: 'future-video-type' });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.code, 'INVALID_VIDEO_TYPE');
  assert.equal(calls.length, 0, 'an unknown preset is rejected before planning');

  const invalidConversation = await postAgent(port, { brief: BRIEF, conversationId: 42 });
  assert.equal(invalidConversation.status, 400);
  assert.equal(invalidConversation.body.code, 'INVALID_CONVERSATION_ID');
  assert.equal(calls.length, 0);

  const selected = await postAgent(port, {
    brief: BRIEF,
    videoType: 'sketch-build',
    conversationId: 'chat_that_does_not_exist_on_disk',
    sessionId: 'video-type-selected',
  });
  assert.equal(selected.status, 400);
  assert.equal(selected.body.error, 'runner capture complete');
  assert.equal(calls.length, 1, 'forwarding conversationId must not load conversation references');
  assert.equal(calls[0].videoType, 'sketch-build');
  assert.equal(calls[0].conversationId, 'chat_that_does_not_exist_on_disk');
  assert.equal(calls[0].brief, BRIEF);

  const music = await postAgent(port, {
    brief: BRIEF,
    videoType: 'music-video',
    conversationId: CHAT,
    songTrim: { startSeconds: 4, endSeconds: 30 },
    performanceBackend: 'fasth3',
    sessionId: 'video-type-music',
  });
  assert.equal(music.status, 400);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].songTrim, { startSeconds: 4, endSeconds: 30 });
  assert.equal(calls[1].performanceBackend, 'fasth3');

  const omitted = await postAgent(port, { brief: BRIEF, sessionId: 'video-type-omitted' });
  assert.equal(omitted.status, 400);
  assert.equal(calls.length, 3);
  assert.equal('videoType' in calls[2], false);
  assert.equal('conversationId' in calls[2], false);
  assert.equal('songTrim' in calls[2], false);
  assert.equal('performanceBackend' in calls[2], false);
  assert.equal('lyricsStyle' in calls[2], false);
  assert.equal('lyrics' in calls[2], false);
  assert.equal('lyricsLrc' in calls[2], false);
  assert.deepEqual(
    Object.keys(calls[2]).sort(),
    Object.keys(calls[0]).filter(key => key !== 'videoType' && key !== 'conversationId').sort(),
    'the no-type runner argument shape remains unchanged',
  );

  const lrc = '[00:04.000]  <b>A&B "lyric"</b>  \n[00:05.500]Next line';
  const lyricRequest = await postAgent(port, {
    brief: BRIEF,
    videoType: 'music-video',
    conversationId: CHAT,
    songTrim: { startSeconds: 4, endSeconds: 30 },
    lyricsStyle: 'caption',
    lyricsLrc: lrc,
  });
  assert.equal(lyricRequest.status, 400);
  assert.equal(calls.length, 4);
  assert.equal(calls[3].brief, BRIEF, 'raw lyrics are never appended to the planning brief');
  assert.equal(calls[3].lyricsStyle, 'caption');
  assert.deepEqual(calls[3].lyrics, [
    { startSeconds: 4, text: '  <b>A&B "lyric"</b>  ' },
    { startSeconds: 5.5, text: 'Next line' },
  ]);
  assert.equal('lyricsLrc' in calls[3], false, 'only canonical cues cross the runner boundary');
  assert.equal(JSON.stringify(calls[3]).includes(lrc), false);

  const invalidStyle = await postAgent(port, { brief: BRIEF, videoType: 'music-video', lyricsStyle: 'scrolling' });
  assert.equal(invalidStyle.status, 400);
  assert.equal(invalidStyle.body.code, 'INVALID_LYRICS_STYLE');
  const nonMusic = await postAgent(port, { brief: BRIEF, videoType: 'sketch-build', lyricsStyle: 'off', lyricsLrc: '[00:00]no' });
  assert.equal(nonMusic.status, 400);
  assert.equal(nonMusic.body.code, 'INVALID_MUSIC_OPTIONS');
  for (const lyricsLrc of ['plain lyric text', '[00:xx]malformed']) {
    const rejected = await postAgent(port, { brief: BRIEF, videoType: 'music-video', lyricsStyle: 'caption', lyricsLrc });
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.code, 'INVALID_LYRICS_LRC');
    assert.ok(rejected.body.details.every(issue => Number.isSafeInteger(issue.line) && issue.line > 0));
  }
  const manyPlainLines = await postAgent(port, {
    brief: BRIEF,
    videoType: 'music-video',
    lyricsLrc: Array.from({ length: 100 }, () => 'untimed').join('\n'),
  });
  assert.equal(manyPlainLines.status, 400);
  assert.ok(manyPlainLines.body.details.length > 0 && manyPlainLines.body.details.length <= 32);
  const overLimit = await postAgent(port, {
    brief: BRIEF,
    videoType: 'music-video',
    lyricsLrc: 'x'.repeat(128 * 1024 + 1),
  });
  assert.equal(overLimit.status, 400);
  assert.equal(overLimit.body.details[0].code, 'LRC_RAW_TOO_LONG');
  assert.equal(overLimit.body.details[0].line, 1);
  assert.equal(calls.length, 4, 'all invalid lyric requests are rejected before the runner');
});

test('Product Walkthrough runner adopts only explicit editorial uploads after planning', async t => {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'comfyrizz-product-attachments-runner-'));
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  const references = createReferenceStore({ rootDir: runtimeDir, chatId: CHAT });
  const editorial = references.add({
    bytes: PNG,
    filename: 'editorial.png',
    meta: { mime: 'image/png', role: 'product' },
  });
  references.update(editorial.id, { usage: 'editorial', editorialScope: 'product-walkthrough' });

  const runner = createCpuAgentRunner({ runtimeDir });
  references.update(editorial.id, { note: 'Use this product frame.' });
  await assert.rejects(() => runner({ brief: BRIEF, videoType: 'product-walkthrough', conversationId: CHAT }),
    error => error.code === 'CONTEXT_REQUIRES_MODEL');
  references.update(editorial.id, { note: '' });
  const result = await runner({ brief: OFFLINE_BRIEF, videoType: 'product-walkthrough', conversationId: CHAT });
  const uploads = Object.entries(result.package.assets).filter(([, asset]) => asset.origin === 'upload');
  assert.equal(uploads.length, 1);
  const [assetId, asset] = uploads[0];
  assert.equal(asset.source.id, editorial.id);
  assert.equal(asset.kind, 'image');
  assert.equal(asset.status, 'ready');
  assert.equal(asset.redistributable, false);
  assert.ok(result.package.scenes.some(scene => scene.foreground?.some(item => item.asset === assetId)));
  assert.equal(result.pendingGpu.length, 1, 'the existing generated-still plan is not replaced by an upload');
});

test('Custom runner places the editorial image without conditioning generated assets', async t => {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'comfyrizz-custom-editorial-runner-'));
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  const references = createReferenceStore({ rootDir: runtimeDir, chatId: CHAT });
  const image = references.add({ bytes: PNG, filename: 'plate.png' });
  references.update(image.id, { usage: 'editorial', editorialScope: 'custom' });
  const result = await createCpuAgentRunner({ runtimeDir })({ brief: OFFLINE_BRIEF, conversationId: CHAT });
  const entry = Object.entries(result.package.assets).find(([, asset]) => asset.source?.id === image.id);
  assert.ok(entry);
  const [id] = entry;
  assert.ok(result.package.scenes.some(scene => scene.foreground?.some(item => item.asset === id)));
  assert.ok(Object.values(result.package.assets).every(asset => asset.gen?.inputs?.reference !== id));
});

test('Music Video runner adopts a real song and plans one bounded FastH3 audition without paid execution', async t => {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'comfyrizz-music-runner-'));
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  const references = createReferenceStore({ rootDir: runtimeDir, chatId: CHAT });
  const song = references.add({
    bytes: wavSeconds(12),
    filename: 'song.wav',
    meta: { mime: 'audio/wav', role: 'song', durationSec: 12, codec: 'pcm_s16le', sampleRate: 24_000, channels: 1 },
  });
  references.update(song.id, { usage: 'editorial' });
  const performer = references.add({
    bytes: PNG,
    filename: 'performer.png',
    meta: { mime: 'image/png', role: 'subject' },
  });
  references.update(performer.id, { usage: 'editorial', editorialScope: 'music-video' });

  const runner = createCpuAgentRunner({ runtimeDir });
  const lyrics = [
    { startSeconds: 0, text: 'Sing <&> "exactly"' },
    { startSeconds: 5.875, text: 'Original song seconds' },
  ];
  const result = await runner({
    brief: `${OFFLINE_BRIEF}\nLength: about 12 seconds.`,
    videoType: 'music-video',
    conversationId: CHAT,
    lyricsStyle: 'reel',
    lyrics,
  });
  assert.equal(result.package.audio.lyricsStyle, 'reel');
  assert.deepEqual(result.package.audio.lyrics, lyrics);
  assert.equal(result.package.voice.enabled, false);
  assert.equal(result.package.audio.music.loop, false);
  assert.deepEqual(result.package.audio.music.trim, { startSeconds: 0, endSeconds: 12 });
  assert.equal(result.package.audio.music.reactive.style, 'waveform');
  assert.equal(result.package.assets[result.package.audio.music.asset].origin, 'upload');
  assert.equal(result.pendingGpu.length, 1);
  assert.equal(result.pendingGpu[0].generator, 'fasth3-omni');
  const performance = result.package.assets[result.pendingGpu[0].assetId];
  assert.equal(performance.status, 'pending');
  assert.equal(performance.gen.inputs.audio.startsWith('a_song_excerpt_'), true);
  assert.equal(performance.media.audio, 'present');
  assert.ok(result.package.scenes.some(scene => scene.background?.asset === result.pendingGpu[0].assetId && scene.background.muted === true));
  assert.ok(result.package.scenes.every(scene => !scene.narration && !scene.narration_asset));
  assert.equal(validatePackage(result.package).valid, true, JSON.stringify(validatePackage(result.package).errors));
});

test('offline planning refuses context it cannot read instead of silently ignoring it', async t => {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'comfyrizz-offline-context-required-'));
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  const references = createReferenceStore({ rootDir: runtimeDir, chatId: CHAT });
  references.add({ bytes: PNG, filename: 'context.png', meta: { mime: 'image/png', note: 'Planning-only note.' } });
  const runner = createCpuAgentRunner({ runtimeDir });
  await assert.rejects(
    () => runner({ brief: BRIEF, videoType: 'motion-explainer', conversationId: CHAT }),
    error => error?.status === 422 && error?.code === 'CONTEXT_REQUIRES_MODEL',
  );
});

test('CPU runner rejects unknown presets and preserves the offline action-scene refusal', async t => {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'comfyrizz-video-types-runner-'));
  const runner = createCpuAgentRunner({ runtimeDir });
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));

  await assert.rejects(
    () => runner({ brief: BRIEF, videoType: 'future-video-type' }),
    error => error?.status === 400 && error?.code === 'INVALID_VIDEO_TYPE',
  );
  await assert.rejects(
    () => runner({ brief: 'A courier crosses a rooftop.', videoType: 'action-scene' }),
    error => error?.code === 'GENERATED_FILM_REQUIRES_MODEL',
  );
  await assert.rejects(
    () => runner({ brief: BRIEF, videoType: 'music-video' }),
    error => error?.status === 422 && error?.code === 'SONG_REQUIRED',
  );
});

test('a silent Sketch Build proposal does not promise the preset soundtrack', async t => {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'comfyrizz-silent-sketch-'));
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  const runner = createCpuAgentRunner({ runtimeDir });
  const result = await runner({ brief: 'Draw an impossible staircase with no narration.', videoType: 'sketch-build' });
  assert.equal(result.package.audio, undefined);
  assert.equal(result.package.proposal.soundtrack, 'Silent preview; no music or sound effects included.');
  assert.equal(validatePackage(result.package).valid, true);
});
