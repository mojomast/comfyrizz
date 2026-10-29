import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { compileTimeline } from '../../../packages/planner/dist/src/index.js';
import { planJobs } from '../../../packages/jobs/src/index.mjs';
import { planPipeline } from '../src/pipeline-contract.mjs';
import { validatePackage } from '../../../packages/schema/src/index.mjs';
import {
  MULTIPLE_SONGS,
  SONG_REQUIRED,
  adoptMusicVideoAttachments,
  fastH3AuditionFrames,
  resolveMusicVideoSong,
} from '../src/music-video.mjs';
import { createReferenceStore } from '../src/references/store.mjs';

const CHAT_ID = 'chat_musicvideo_test';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function waveSeconds(seconds) {
  const sampleRate = 24000;
  const frames = Math.round(sampleRate * seconds);
  const dataSize = frames * 2;
  const bytes = Buffer.alloc(44 + dataSize);
  bytes.write('RIFF', 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); // integer PCM
  bytes.writeUInt16LE(1, 22); // mono
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(dataSize, 40);
  for (let frame = 0; frame < frames; frame += 1) {
    bytes.writeInt16LE((frame % 400) - 200, 44 + frame * 2);
  }
  return bytes;
}

const wave4Seconds = () => waveSeconds(4);

function runtimeWithReferences(t, specs) {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'comfyrizz-music-video-'));
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  const store = createReferenceStore({ rootDir: runtimeDir, chatId: CHAT_ID });
  const references = specs.map((spec, index) => {
    const bytes = spec.bytes ?? Buffer.from(`${spec.kind}-${index}-original-bytes`);
    const sha256 = digest(bytes);
    const id = spec.id ?? `ref_${sha256.slice(0, 16)}`;
    const ext = spec.ext ?? (spec.kind === 'audio' ? 'mp3' : 'png');
    const file = `${id}.${ext}`;
    writeFileSync(join(store.filesDir, file), bytes, { mode: 0o600 });
    return {
      schema: 'comfyrizz.reference/v1',
      id,
      kind: spec.kind,
      mime: spec.kind === 'audio' ? 'audio/mpeg' : 'image/png',
      file,
      bytes: bytes.length,
      sha256: spec.sha256 ?? sha256,
      ...(spec.kind === 'image' ? { width: 1920, height: 1080 } : {}),
      role: spec.role ?? (spec.kind === 'audio' ? 'song' : 'character'),
      usage: spec.usage ?? 'editorial',
      ...(spec.kind === 'image' ? { editorialScope: spec.editorialScope === null ? undefined : (spec.editorialScope ?? 'music-video') } : {}),
      rightsAsserted: true,
      note: spec.note ?? '',
      label: spec.label ?? id,
      createdAt: '2026-10-28T00:00:00.000Z',
      revision: 1,
      frames: [],
    };
  });
  writeFileSync(store.statePath, JSON.stringify({
    schema: 'comfyrizz.reference-library/v1',
    chatId: CHAT_ID,
    revision: 1,
    updatedAt: '2026-10-28T00:00:00.000Z',
    references,
    assignments: [],
  }), { mode: 0o600 });
  return { runtimeDir, store, references };
}

function makePackage({ oldPending = false } = {}) {
  const firstBackground = oldPending
    ? { asset: 'a_old_klein', muted: true }
    : { procedural: { pattern: 'gradient', palette: ['#0d0f14', '#6d8cff'] } };
  return {
    $schema: 'https://comfyrizz.example/schema/package-v1.json',
    schemaVersion: 1,
    revision: 1,
    id: 'pkg_musicvideo01',
    title: 'Music video test',
    createdAt: '2026-10-28T00:00:00.000Z',
    format: { width: 1920, height: 1080, fps: 30 },
    duration: { mode: 'target', targetFrames: 240 },
    voice: { enabled: true, engine: 'kokoro', voice: 'af_heart' },
    scenes: [
      {
        id: 's1', layout: 'hero', preferredFrames: 120,
        copy: { headline: 'First section' },
        background: firstBackground,
        narration: 'Old narration that must not be synthesized.',
        transitionOut: { type: 'fade', frames: 15 },
      },
      {
        id: 's2', layout: 'hero', preferredFrames: 120,
        copy: { headline: 'Second section' },
        background: { procedural: { pattern: 'dots', seed: 2 } },
        narration: 'More old narration.',
        transitionOut: { type: 'fade', frames: 15 },
      },
    ],
    assets: {
      a_old_score: {
        kind: 'audio', origin: 'generated', status: 'ready',
        file: 'assets/a_old_score.wav', sha256: 'a'.repeat(64), bytes: 100,
        media: { durationSeconds: 8, codec: 'pcm_s16le' },
        license: { id: 'CC0-1.0' }, redistributable: true,
        gen: { generator: 'procedural-audio', inputs: { plan: 'old score', seed: 1 } },
      },
      ...(oldPending ? {
        a_old_klein: {
          kind: 'image', origin: 'generated', status: 'pending',
          gen: {
            generator: 'flux3-klein',
            workflow: 'workflows/flux3_klein_t2i.api.json',
            inputs: { prompt: 'old visual', width: 1920, height: 1080, seed: 3 },
          },
        },
      } : {}),
    },
    audio: { music: { asset: 'a_old_score', loop: true } },
    compliance: { open_weights_only: true, backends_used: [] },
  };
}

function probeResult(duration = 40) {
  return {
    stdout: JSON.stringify({
      streams: [{ codec_name: 'mp3', sample_rate: '44100', channels: 2, duration: String(duration) }],
      format: { duration: String(duration) },
    }),
  };
}

function injectedExec(calls, { duration = 40, excerpt } = {}) {
  return async (command, args) => {
    calls.push({ command, args: [...args] });
    if (command === 'ffprobe') return probeResult(duration);
    if (command === 'ffmpeg') {
      const seconds = Number(args[args.indexOf('-t') + 1]);
      writeFileSync(args.at(-1), excerpt ?? waveSeconds(seconds));
      return { stdout: '' };
    }
    throw new Error(`unexpected command ${command}`);
  };
}

async function adopt(t, { specs, pkg = makePackage(), duration = 40, calls = [], ...options } = {}) {
  const { runtimeDir, store, references } = runtimeWithReferences(t, specs ?? [{ kind: 'audio' }]);
  const result = await adoptMusicVideoAttachments({
    runtimeDir,
    conversationId: CHAT_ID,
    package: pkg,
    exec: injectedExec(calls, { duration }),
    ...options,
  });
  return { result, runtimeDir, store, references };
}

test('audition excerpt follows the normalized scene offset within the source trim', async t => {
  const pkg = makePackage();
  pkg.scenes[0].layout = 'title';
  const calls = [];
  const { result } = await adopt(t, {
    specs: [{ kind: 'audio' }, { kind: 'image' }], pkg, calls,
    songTrim: { startSeconds: 3, endSeconds: 15 }, performanceBackend: 'ltx',
  });
  assert.ok(result.performance);
  const scene = compileTimeline(result.package).scenes.find(s => s.id === result.performance.sceneId);
  const expected = 3 + scene.from / result.package.format.fps;
  assert.ok(scene.from > 0);
  assert.equal(result.performance.excerpt.startSeconds, expected);
  assert.equal(Number(calls.find(call => call.command === 'ffmpeg').args[calls.find(call => call.command === 'ffmpeg').args.indexOf('-ss') + 1]), Number(expected.toFixed(6)));
  assert.equal(result.package.assets[result.performance.audioAssetId].gen.inputs.start_seconds, expected);
  assert.ok(result.performance.excerpt.endSeconds <= 15);
  const plan = planPipeline(result.package, { backendId: 'byo-comfyui' });
  assert.ok(plan.warnings.some(w => w.code === 'MUSIC_AUDITION_SYNC_UNSUPPORTED' && /do not run/.test(w.message)));
});

test('audition is skipped when rounded timeline would put its source excerpt outside the trim', async t => {
  const pkg = makePackage();
  pkg.scenes[0].layout = 'title';
  const calls = [];
  const { result } = await adopt(t, {
    specs: [{ kind: 'audio' }, { kind: 'image' }], pkg, calls,
    songTrim: { startSeconds: 3, endSeconds: 7.99 }, performanceBackend: 'ltx',
  });
  assert.equal(result.performance, null);
  assert.equal(result.skipped[0].code, 'PERFORMANCE_EXCERPT_OUTSIDE_TRIM');
  assert.equal(calls.some(call => call.command === 'ffmpeg'), false);
});

test('early song resolution requires one editorial song and ignores reference-only audio', t => {
  const missing = runtimeWithReferences(t, [{ kind: 'audio', usage: 'reference' }]);
  assert.throws(
    () => resolveMusicVideoSong({ store: missing.store }),
    error => error.code === SONG_REQUIRED && error.status === 422,
  );

  const one = runtimeWithReferences(t, [
    { kind: 'audio', usage: 'reference' },
    { kind: 'audio', usage: 'editorial' },
  ]);
  assert.equal(resolveMusicVideoSong({ store: one.store }).usage, 'editorial');

  const multiple = runtimeWithReferences(t, [
    { kind: 'audio', bytes: Buffer.from('song one') },
    { kind: 'audio', bytes: Buffer.from('song two') },
  ]);
  assert.throws(
    () => resolveMusicVideoSong({ store: multiple.store }),
    error => error.code === MULTIPLE_SONGS && error.status === 422,
  );
});

test('adoption preserves exact master bytes and metadata, disables other audio, and defaults trim/reactive timing', async t => {
  const original = Buffer.from('not-a-transcoded-master');
  const sourcePackage = makePackage();
  const originalBackgrounds = structuredClone(sourcePackage.scenes.map(scene => scene.background));
  const { result, runtimeDir } = await adopt(t, {
    specs: [{ kind: 'audio', bytes: original }],
    pkg: sourcePackage,
  });

  const { package: adopted, song } = result;
  const master = adopted.assets[song.assetId];
  assert.equal(master.origin, 'upload');
  assert.equal(master.status, 'ready');
  assert.equal(master.kind, 'audio');
  assert.equal(master.sha256, digest(original));
  assert.equal(master.bytes, original.length);
  assert.deepEqual(readFileSync(join(runtimeDir, 'packages', 'assets', basename(master.file))), original);
  assert.equal(master.license.id, 'User-Upload');
  assert.equal(master.license.approved_by_user, true);
  assert.equal(master.redistributable, false);
  assert.deepEqual(master.media, {
    durationSeconds: 40, audio: 'present', codec: 'mp3', sampleRate: 44100, channels: 2,
  });

  assert.equal(adopted.audio.music.asset, song.assetId);
  assert.equal(adopted.audio.music.loop, false);
  assert.equal(adopted.audio.music.duck.enabled, false);
  assert.deepEqual(adopted.audio.music.trim, { startSeconds: 0, endSeconds: 30 });
  assert.deepEqual(adopted.audio.music.reactive, { style: 'waveform', intensity: 0.8 });
  assert.deepEqual(adopted.voice, { enabled: false, engine: 'none' });
  assert.equal(adopted.assets[adopted.audio.music.asset].gen, undefined);
  assert.ok(adopted.scenes.every(scene => !('narration' in scene) && !('narration_asset' in scene)));
  assert.deepEqual(adopted.scenes.map(scene => scene.background), originalBackgrounds);
  assert.equal(result.performance, null);
  assert.equal(result.skipped[0].code, 'NO_EDITORIAL_IMAGE');
  assert.equal(adopted.duration.targetFrames, 900);
  assert.equal(adopted.scenes.reduce((sum, scene) => sum + scene.preferredFrames, 0), 900);
  assert.ok(adopted.scenes.every(scene => scene.transitionOut.type === 'cut' && scene.transitionOut.frames === 0));
  assert.equal(compileTimeline(adopted).durationInFrames, 900);
  assert.equal(validatePackage(adopted).valid, true, JSON.stringify(validatePackage(adopted).errors));
  assert.equal(validatePackage(sourcePackage).valid, true, 'the pre-adoption package remains schema-conformant');
});

test('requestedSeconds and explicit trim are honored; invalid windows and unreasonable clips fail closed', async t => {
  const requested = await adopt(t, { requestedSeconds: 12 });
  assert.deepEqual(requested.result.package.audio.music.trim, { startSeconds: 0, endSeconds: 12 });
  assert.equal(requested.result.package.duration.targetFrames, 360);

  const custom = await adopt(t, { songTrim: { startSeconds: 5, endSeconds: 17 } });
  assert.deepEqual(custom.result.package.audio.music.trim, { startSeconds: 5, endSeconds: 17 });
  assert.equal(custom.result.song.trimmedDurationSeconds, 12);
  assert.equal(compileTimeline(custom.result.package).durationInFrames, 360);

  const shorterSongWins = await adopt(t, { requestedSeconds: 400 });
  assert.deepEqual(shorterSongWins.result.package.audio.music.trim, { startSeconds: 0, endSeconds: 40 });

  for (const songTrim of [
    { startSeconds: -1, endSeconds: 2 },
    { startSeconds: 1, endSeconds: 1 },
    { startSeconds: 2, endSeconds: 1 },
    { startSeconds: 0, endSeconds: 41 },
    { startSeconds: Number.NaN, endSeconds: 2 },
  ]) {
    await assert.rejects(adopt(t, { songTrim }), error => error.code === 'INVALID_SONG_TRIM' && error.status === 422);
  }
  await assert.rejects(adopt(t, { requestedSeconds: 0 }), error => error.code === 'INVALID_REQUESTED_SECONDS');
  await assert.rejects(
    adopt(t, { duration: 1000, songTrim: { startSeconds: 0, endSeconds: 301 } }),
    error => error.code === 'SONG_TRIM_TOO_LONG',
  );
  await assert.rejects(
    adopt(t, { duration: 1000, requestedSeconds: 301 }),
    error => error.code === 'SONG_TRIM_TOO_LONG',
  );
});

test('stored song hash mismatches are surfaced instead of adopting different bytes', async t => {
  await assert.rejects(
    adopt(t, { specs: [{ kind: 'audio', sha256: '0'.repeat(64) }] }),
    error => error.code === 'HASH_MISMATCH' && error.status === 422,
  );
});

test('FastH3 audition frame helper floors to 17n+5 with the experimental minimum', () => {
  assert.equal(fastH3AuditionFrames(2), 56);
  assert.equal(fastH3AuditionFrames(4), 90);
  assert.equal(fastH3AuditionFrames(6), 141);
  assert.equal(fastH3AuditionFrames(1), 56);
  assert.equal((141 - 5) % 17, 0);
  assert.equal(141 / 24, 5.875);
  assert.throws(() => fastH3AuditionFrames(0), RangeError);
});

test('FastH3 is the default native-AV audition with direct audio-reuse prompt and real job inputs', async t => {
  const songBytes = Buffer.from('h3-original-master');
  const imageBytes = Buffer.from('h3-original-performer');
  const calls = [];
  const sourcePackage = makePackage({ oldPending: true });
  sourcePackage.assets.a_old_ltx = {
    kind: 'video', origin: 'generated', status: 'pending',
    gen: {
      generator: 'ltx25', workflow: 'workflows/ltx25_t2v_2stage.api.json',
      inputs: { prompt: 'old LTX visual', frames: 97, fps: 24 },
    },
  };
  sourcePackage.scenes[0].background = { asset: 'a_old_ltx', muted: true };
  const { result, runtimeDir } = await adopt(t, {
    specs: [{ kind: 'audio', bytes: songBytes }, { kind: 'image', bytes: imageBytes }],
    pkg: sourcePackage,
    calls,
    requestedSeconds: 12,
    performanceSeconds: 6,
  });
  const { package: adopted, performance } = result;
  assert.equal(performance.backend, 'fasth3');
  assert.equal(performance.generator, 'fasth3-omni');
  assert.equal(performance.frames, 141);
  assert.equal(performance.durationSeconds, 5.875);
  assert.equal(performance.sceneFrames, 176);
  assert.equal(performance.editorialDurationSeconds, 176 / 30);

  const image = adopted.assets[performance.imageAssetId];
  const excerpt = adopted.assets[performance.audioAssetId];
  const video = adopted.assets[performance.videoAssetId];
  assert.equal(video.status, 'pending');
  assert.equal(video.gen.workflow, 'workflows/fasth3_omni_ref2va.api.json');
  assert.equal(video.gen.model, 'fasth3-omni');
  assert.equal(video.gen.workflow_sha256, digest(readFileSync(new URL('../../../workflows/fasth3_omni_ref2va.api.json', import.meta.url))));
  assert.equal(video.model_license.id, 'LicenseRef-MiniMax-H3-Community');
  assert.match(video.model_license.url, /MiniMaxAI\/MiniMax-H3/);
  assert.equal(video.license.id, 'LicenseRef-MiniMax-H3-Community');
  assert.equal(video.redistributable, false);
  assert.deepEqual(video.media, {
    width: 1344, height: 768, fps: 24, frames: 141, durationSeconds: 5.875, audio: 'present',
  });
  assert.equal(video.gen.inputs.image, performance.imageAssetId);
  assert.equal(video.gen.inputs.reference, performance.imageAssetId);
  assert.equal(video.gen.inputs.audio, performance.audioAssetId);
  assert.equal(video.gen.inputs.width, 1344);
  assert.equal(video.gen.inputs.height, 768);
  assert.equal(video.gen.inputs.frames, 141);
  assert.equal(video.gen.inputs.fps, 24);
  assert.equal(video.gen.inputs.audio_retention, undefined);
  assert.equal(video.gen.direction, undefined);
  assert.match(video.gen.inputs.prompt, /<Picture 1> is the identity reference/);
  assert.match(video.gen.inputs.prompt, /<Picture 2> is the composition reference/);
  assert.match(video.gen.inputs.prompt, /<Audio 1> is the complete supplied song/);
  assert.match(video.gen.inputs.prompt, /summary:\s*audio reuse/);
  assert.match(video.gen.inputs.prompt, /retention_analysis:[\s\S]*<Audio 1>: fully_copy - complete final track/);
  assert.match(video.gen.inputs.prompt, /Natural singing\/performance to <Audio 1>/);
  assert.match(video.gen.inputs.prompt, /No new dialogue or additional score/);
  assert.doesNotMatch(video.gen.inputs.prompt, /bit-exact|perfect lip sync/i);

  const expectedExcerpt = waveSeconds(141 / 24);
  assert.equal(excerpt.sha256, digest(expectedExcerpt));
  assert.equal(excerpt.media.durationSeconds, 141 / 24);
  assert.equal(excerpt.media.frames, 141);
  assert.equal(excerpt.media.sampleRate, 24000);
  assert.equal(excerpt.media.channels, 1);
  assert.equal(expectedExcerpt.readUInt32LE(40), 141 * 1000 * 2);
  assert.deepEqual(readFileSync(join(runtimeDir, 'packages', 'assets', basename(excerpt.file))), expectedExcerpt);
  assert.equal(image.sha256, digest(imageBytes));
  assert.equal(adopted.assets[result.song.assetId].sha256, digest(songBytes));
  assert.deepEqual(readFileSync(join(runtimeDir, 'packages', 'assets', basename(adopted.assets[result.song.assetId].file))), songBytes);
  assert.equal(adopted.audio.music.asset, result.song.assetId);

  const scene = adopted.scenes.find(candidate => candidate.id === performance.sceneId);
  assert.equal(scene.preferredFrames, 176);
  assert.equal(scene.background.muted, true);
  assert.equal(scene.background.asset, performance.videoAssetId);
  assert.equal(scene.media_only, true);
  const timeline = compileTimeline(adopted);
  assert.equal(timeline.durationInFrames, 360);
  assert.equal(timeline.scenes.find(item => item.id === scene.id).durationInFrames, 176);
  assert.equal(adopted.scenes.find(item => item.id !== scene.id).preferredFrames, 184);
  assert.deepEqual(result.pendingGpu, [{
    assetId: performance.videoAssetId,
    generator: 'fasth3-omni',
    workflow: 'workflows/fasth3_omni_ref2va.api.json',
    sceneId: 's1',
  }]);
  assert.equal(result.pendingGpu.some(item => item.generator === 'ltx25-a2v' || item.generator === 'ltx25'), false);

  const plan = planJobs(adopted);
  assert.equal(plan.jobs.length, 1, JSON.stringify(plan.jobs, null, 2));
  const [job] = plan.jobs;
  assert.equal(job.generator, 'fasth3-omni');
  assert.equal(job.frames, 141);
  assert.equal(job.params.frames, 141);
  assert.deepEqual(job.dims, { width: 1344, height: 768 });
  assert.equal(job.params.prompt, video.gen.inputs.prompt);
  assert.deepEqual(job.fileInputs, [
    { param: 'image', from: 'package', path: image.file },
    { param: 'reference', from: 'package', path: image.file },
    { param: 'audio', from: 'package', path: excerpt.file },
  ]);
  assert.ok(plan.warnings.some(warning => warning.code === 'PLAN_H3_DUPLICATE_REFERENCE'));
  const cacheKey = job.cacheKey;
  const changedAudio = structuredClone(adopted);
  changedAudio.assets[performance.audioAssetId].sha256 = 'f'.repeat(64);
  assert.notEqual(planJobs(changedAudio).jobs[0].cacheKey, cacheKey);
  assert.equal(validatePackage(adopted).valid, true, JSON.stringify(validatePackage(adopted).errors));
  assert.deepEqual(calls.map(call => call.command), ['ffprobe', 'ffmpeg'], 'only CPU probing/excerpt work executes');
  const ffmpeg = calls.find(call => call.command === 'ffmpeg');
  assert.equal(ffmpeg.args[ffmpeg.args.indexOf('-t') + 1], '5.875');
});

test('FastH3 2/4/6-second requests produce exact source-grid PCM and keep scene duration locked', async t => {
  for (const [requestedSeconds, frames] of [[2, 56], [4, 90], [6, 141]]) {
    const { result, runtimeDir } = await adopt(t, {
      specs: [{ kind: 'audio' }, { kind: 'image' }],
      requestedSeconds: 12,
      performanceSeconds: requestedSeconds,
    });
    const { package: adopted, performance } = result;
    const excerpt = adopted.assets[performance.audioAssetId];
    const scene = adopted.scenes.find(candidate => candidate.id === performance.sceneId);
    const expectedSceneFrames = Math.round((frames / 24) * adopted.format.fps);
    assert.equal(performance.frames, frames);
    assert.equal(performance.sceneFrames, expectedSceneFrames);
    assert.equal(scene.preferredFrames, expectedSceneFrames);
    assert.equal(excerpt.media.durationSeconds, frames / 24);
    const bytes = readFileSync(join(runtimeDir, 'packages', 'assets', basename(excerpt.file)));
    assert.equal(bytes.readUInt32LE(40), frames * 1000 * 2, `${requestedSeconds}s PCM byte count`);
    assert.deepEqual(bytes, waveSeconds(frames / 24));
    const timeline = compileTimeline(adopted);
    assert.equal(timeline.durationInFrames, 360);
    assert.equal(timeline.scenes.find(item => item.id === scene.id).durationInFrames, expectedSceneFrames);
    assert.equal(adopted.scenes.find(item => item.id !== scene.id).preferredFrames, 360 - expectedSceneFrames);
    assert.equal(planJobs(adopted).jobs[0].frames, frames);
  }
});

test('optional LTX comparison retains its exact four-second PCM excerpt and one pending job', async t => {
  const songBytes = Buffer.from('original-song-not-the-excerpt');
  const imageBytes = Buffer.from('original-editorial-image');
  const excerptBytes = wave4Seconds();
  const calls = [];
  const sourcePackage = makePackage({ oldPending: true });
  const { result, runtimeDir, references } = await adopt(t, {
    specs: [{ kind: 'audio', bytes: songBytes }, { kind: 'image', bytes: imageBytes }],
    pkg: sourcePackage,
    calls,
    requestedSeconds: 12,
    performanceBackend: 'ltx',
  });
  const { package: adopted, performance } = result;
  assert.equal(performance.status, 'pending');
  assert.equal(performance.backend, 'ltx');
  assert.equal(performance.generator, 'ltx25-a2v');
  assert.equal(performance.sceneId, 's1');
  assert.equal(performance.frames, 97);
  assert.equal(performance.fps, 24);
  assert.equal(performance.requiresHumanReview, true);

  const image = adopted.assets[performance.imageAssetId];
  assert.equal(image.origin, 'upload');
  assert.equal(image.status, 'ready');
  assert.equal(image.sha256, digest(imageBytes));
  assert.equal(image.source.id, references[1].id);
  assert.equal(image.redistributable, false);
  assert.deepEqual(readFileSync(join(runtimeDir, 'packages', 'assets', basename(image.file))), imageBytes);

  const excerpt = adopted.assets[performance.audioAssetId];
  assert.equal(excerpt.status, 'ready');
  assert.equal(excerpt.origin, 'generated');
  assert.equal(excerpt.gen.generator, 'procedural-audio');
  assert.equal(excerpt.sha256, digest(excerptBytes));
  assert.equal(excerpt.source.id, result.song.assetId);
  assert.equal(excerpt.gen.inputs.source_asset, result.song.assetId);
  assert.equal(excerpt.gen.inputs.source_sha256, digest(songBytes));
  assert.equal(excerpt.license.id, 'User-Upload');
  assert.equal(excerpt.redistributable, false);
  assert.equal(excerpt.media.codec, 'pcm_s16le');
  assert.equal(excerpt.media.sampleRate, 24000);
  assert.equal(excerpt.media.channels, 1);
  assert.equal(excerpt.media.frames, 97);
  assert.deepEqual(readFileSync(join(runtimeDir, 'packages', 'assets', basename(excerpt.file))), excerptBytes);
  assert.notDeepEqual(excerptBytes, songBytes);

  const video = adopted.assets[performance.videoAssetId];
  assert.equal(video.status, 'pending');
  assert.equal(video.gen.generator, 'ltx25-a2v');
  assert.equal(video.gen.workflow, 'workflows/ltx25_a2v_2stage.api.json');
  assert.match(video.gen.workflow_sha256, /^[a-f0-9]{64}$/);
  assert.equal(video.gen.inputs.image, performance.imageAssetId);
  assert.equal(video.gen.inputs.audio, performance.audioAssetId);
  assert.equal(video.gen.inputs.width, 1920);
  assert.equal(video.gen.inputs.height, 1080);
  assert.equal(video.gen.inputs.fps, 24);
  assert.equal(video.gen.inputs.frames, 97);
  assert.equal(video.gen.inputs.seed, performance.seed);
  assert.match(video.gen.inputs.prompt, /fictional/i);
  assert.doesNotMatch(JSON.stringify([image, excerpt, video]), /fasth3|kokoro|qwen3-tts/i);

  const scene = adopted.scenes.find(candidate => candidate.id === performance.sceneId);
  assert.equal(scene.background.asset, performance.videoAssetId);
  assert.equal(scene.background.muted, true);
  assert.equal(scene.background.loop, false);
  assert.equal(scene.media_only, true);
  assert.equal(scene.preferredFrames, 120);
  assert.equal(scene.preferredFrames, performance.sceneFrames);
  assert.equal(compileTimeline(adopted).durationInFrames, 360);
  assert.equal(compileTimeline(adopted).scenes.find(item => item.id === scene.id).durationInFrames, 120);
  assert.deepEqual(result.pendingGpu, [{
    assetId: performance.videoAssetId,
    generator: 'ltx25-a2v',
    workflow: 'workflows/ltx25_a2v_2stage.api.json',
    sceneId: 's1',
  }]);
  assert.equal(result.pendingGpu.some(item => item.assetId === 'a_old_klein'), false, 'replaced Klein work is not stale');

  const jobs = planJobs(adopted).jobs;
  assert.equal(jobs.length, 1, JSON.stringify(jobs, null, 2));
  assert.equal(jobs[0].asset, performance.videoAssetId);
  assert.equal(jobs[0].generator, 'ltx25-a2v');
  assert.equal(jobs[0].params.frames, 97);
  assert.equal(jobs[0].params.fps, 24);
  assert.equal(jobs.some(job => job.kind === 'upload' || /upload/i.test(job.kind)), false);
  assert.equal(jobs[0].fileInputs.length, 2);
  assert.deepEqual(new Set(jobs[0].fileInputs.map(input => input.param)), new Set(['image', 'audio']));
  assert.ok(jobs[0].fileInputs.every(input => input.from === 'package'));
  assert.equal(validatePackage(adopted).valid, true, JSON.stringify(validatePackage(adopted).errors));

  const ffmpeg = calls.find(call => call.command === 'ffmpeg');
  assert.ok(ffmpeg);
  assert.ok(Array.isArray(ffmpeg.args));
  assert.deepEqual(ffmpeg.args.slice(0, 4), ['-nostdin', '-v', 'error', '-y']);
  assert.equal(ffmpeg.args[ffmpeg.args.indexOf('-ss') + 1], '0');
  assert.equal(ffmpeg.args[ffmpeg.args.indexOf('-t') + 1], '4');
  assert.equal(ffmpeg.args[ffmpeg.args.indexOf('-ac') + 1], '1');
  assert.equal(ffmpeg.args[ffmpeg.args.indexOf('-ar') + 1], '24000');
  assert.equal(ffmpeg.args[ffmpeg.args.indexOf('-c:a') + 1], 'pcm_s16le');
});

test('no editorial performer image means no FFmpeg excerpt, no performance backend and unchanged visuals', async t => {
  const calls = [];
  const sourcePackage = makePackage({ oldPending: true });
  const oldBackground = structuredClone(sourcePackage.scenes[0].background);
  const { result } = await adopt(t, { specs: [{ kind: 'audio' }], pkg: sourcePackage, calls });
  assert.equal(result.performance, null);
  assert.equal(calls.some(call => call.command === 'ffmpeg'), false);
  assert.equal(Object.values(result.package.assets).some(asset => ['ltx25-a2v', 'fasth3-omni'].includes(asset.gen?.generator)), false);
  assert.deepEqual(result.package.scenes[0].background, oldBackground);
  assert.equal(result.package.scenes[0].media_only, undefined);
  assert.deepEqual(result.pendingGpu.map(item => item.assetId), ['a_old_klein']);
});

test('Custom and legacy unscoped images cannot become a Music Video performer', async t => {
  for (const editorialScope of ['custom', 'product-walkthrough', null]) {
    const calls = [];
    const { result } = await adopt(t, { specs: [{ kind: 'audio' }, { kind: 'image', editorialScope }], calls });
    assert.equal(result.performance, null);
    assert.equal(calls.some(call => call.command === 'ffmpeg'), false);
    assert.ok(Object.values(result.package.assets).every(asset => asset.kind !== 'image' || asset.origin !== 'upload'));
  }
});

test('a short trim reports the skipped audition and never leaves a partial performance plan', async t => {
  const { result } = await adopt(t, {
    specs: [{ kind: 'audio' }, { kind: 'image' }],
    songTrim: { startSeconds: 0, endSeconds: 3 },
  });
  assert.equal(result.performance, null);
  assert.equal(result.skipped[0].code, 'PERFORMANCE_TRIM_TOO_SHORT');
  assert.equal(Object.values(result.package.assets).some(asset => ['ltx25-a2v', 'fasth3-omni'].includes(asset.gen?.generator)), false);
  assert.equal(result.pendingGpu.length, 0);
});
