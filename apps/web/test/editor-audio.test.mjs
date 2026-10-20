import assert from 'node:assert/strict';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { applyCommand } from '../src/editor/commands.ts';
import { createEditorStore } from '../src/editor/store.ts';
import { sha256 } from '../src/editor/hash.ts';
import { clearWaveformCache } from '../src/editor/audio/waveform-cache.ts';
import { loadPeaks } from '../src/editor/audio/waveform.ts';
import { computePeaks } from '../src/editor/audio/peaks.ts';
import {
  NARRATION_PLAYBACK_RATE,
  assembleNarration,
  chunkCrosses,
  placeScenes,
  rangeDurationSeconds,
  sentenceCues,
  seekFrameForSentence,
} from '../src/editor/audio/speech.ts';
import { sceneStatus, staleAssets, staleWork } from '../src/editor/audio/status.ts';
import { auditionParams } from '../src/editor/audio/audition.ts';
import { resolveAudioMix, AUDIO_MIX_DEFAULTS } from '../../renderer/src/audio-mix-model.js';
import { resolveVoicePreview } from '../src/editor/audio/voice-preview.ts';
import { containsSecret, editorExportSidecar } from '../src/editor/media/export-doc.ts';
import { LONG_MEDIA_BYTES, mediaPlaybackUrl, peaksFromRangedWav, peaksOfPcm } from '../src/editor/media/range-reader.ts';
import { compileTimeline } from '../../../packages/planner/dist/src/index.js';
import { conditioningHash, narrationInputFingerprint, textFingerprint } from '../src/editor/audio/speech.ts';

function speechDoc() {
  const narration = 'one two three four';
  const scene = {
    id: 's1', layout: 'title', preferredFrames: 90, narration, narration_asset: 'a_voice',
    transitionOut: { type: 'cut', frames: 0 }, copy: { headline: 'Open' },
  };
  const voice = { enabled: true, engine: 'kokoro', voice: 'af_heart', speed: 1 };
  const doc = {
    package: {
      id: 'pkg_speech', title: 'Speech', revision: 1,
      format: { width: 1920, height: 1080, fps: 30 },
      duration: { mode: 'flexible' },
      voice, scenes: [scene],
      presenter: { enabled: true, scenes: 'all', portrait: 'a_face' },
      assets: {
        a_voice: { kind: 'audio', status: 'ready', file: 'audio/s1.wav' },
        a_bed: { kind: 'audio', status: 'ready', file: 'audio/bed.wav' },
        a_still: { kind: 'image', status: 'ready', file: 'assets/still.png' },
        a_pres: { kind: 'video', status: 'ready', file: 'assets/presenter.mp4' },
      },
      audio: { music: { asset: 'a_bed', fade_in_seconds: 0, fade_out_seconds: 0 } },
    },
    editor: { version: 1, captionOverrides: [], takes: {}, alignment: {}, presenterClips: {} },
  };
  const take = {
    takeId: 'take-s1', assetId: 'a_voice', sourceHash: 'hash-s1',
    inputFingerprint: narrationInputFingerprint(scene, voice),
    sampleRate: 8000, sampleCount: 8000, range: { inSample: 0, outSample: 8000 },
  };
  doc.editor.takes.s1 = take;
  doc.editor.alignment.s1 = {
    sourceHash: 'hash-s1', textFingerprint: textFingerprint(narration),
    chunks: [{
      text: narration, seconds: 1,
      words: [
        { text: 'one', start: 0, end: 0.25 },
        { text: 'two', start: 0.25, end: 0.5 },
        { text: 'three', start: 0.5, end: 0.75 },
        { text: 'four', start: 0.75, end: 1 },
      ],
    }],
  };
  doc.editor.presenterClips.s1 = { assetId: 'a_pres', conditioningHash: conditioningHash(take) };
  return doc;
}

function withSecondScene(doc) {
  const scene = {
    id: 's2', layout: 'title', preferredFrames: 90, narration: 'second scene stays',
    narration_asset: 'a_voice2', transitionOut: { type: 'cut', frames: 0 }, copy: { headline: 'Next' },
  };
  doc.package.scenes.push(scene);
  const take = {
    takeId: 'take-s2', assetId: 'a_voice2', sourceHash: 'hash-s2',
    inputFingerprint: narrationInputFingerprint(scene, doc.package.voice),
    sampleRate: 8000, sampleCount: 4000, range: { inSample: 0, outSample: 4000 },
  };
  doc.editor.takes.s2 = take;
  doc.editor.alignment.s2 = {
    sourceHash: 'hash-s2', textFingerprint: textFingerprint(scene.narration),
    chunks: [{ text: scene.narration, seconds: 0.5 }],
  };
  doc.editor.presenterClips.s2 = { assetId: 'a_pres2', conditioningHash: conditioningHash(take) };
  doc.package.assets.a_voice2 = { kind: 'audio', status: 'ready', file: 'audio/s2.wav' };
  doc.package.assets.a_pres2 = { kind: 'video', status: 'ready', file: 'assets/presenter-2.mp4' };
  return doc;
}

test('production voice controls invalidate existing takes and undo restores their freshness', () => {
  for (const change of [
    { chunking: 'paragraph' },
    { blend: [{ voice: 'af_heart', weight: .7 }, { voice: 'af_bella', weight: .3 }] },
    { qwen_mode: 'custom' }, { delivery: 'A warm delivery' },
    { non_streaming: true }, { reference_text: 'A new reference performance.' },
  ]) {
    const doc = speechDoc();
    const store = createEditorStore(doc);
    assert.equal(sceneStatus(store.getState().doc, 's1').take, 'fresh');
    assert.equal(store.dispatch({ type: 'SetVoice', voice: { ...doc.package.voice, ...change } }).ok, true);
    assert.equal(sceneStatus(store.getState().doc, 's1').take, 'stale', JSON.stringify(change));
    assert.equal(sceneStatus(store.getState().doc, 's1').alignment, 'stale');
    store.undo();
    assert.equal(sceneStatus(store.getState().doc, 's1').take, 'fresh');
  }
});

test('sha256 matches known vectors', () => {
  assert.equal(sha256(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('split and reorder keep narration samples identical and unstretched', () => {
  const samples = Float32Array.from({ length: 8000 }, (_, index) => index);
  const store = createEditorStore(speechDoc());
  const before = structuredClone(store.getState().doc);
  const split = store.dispatch({ type: 'SplitScene', sceneId: 's1', frame: 15, newSceneId: 's1b' });
  assert.equal(split.ok, true, split.error);
  const doc = store.getState().doc;
  const left = doc.editor.takes.s1;
  const right = doc.editor.takes.s1b;
  assert.equal(left.range.outSample, right.range.inSample);
  assert.deepEqual(left.range, { inSample: 0, outSample: 4000 });
  assert.deepEqual(right.range, { inSample: 4000, outSample: 8000 });
  assert.notDeepEqual(left.range, before.editor.takes.s1.range);
  assert.equal(left.sampleRate, 8000);
  assert.equal(NARRATION_PLAYBACK_RATE, 1);
  assert.equal(rangeDurationSeconds(left) + rangeDurationSeconds(right), 1);
  const pcm = new Map([['hash-s1', samples]]);
  const joined = assembleNarration([left, right], pcm);
  assert.deepEqual(joined, samples);
  store.dispatch({ type: 'MoveScene', sceneId: 's1b', toIndex: 0 });
  const moved = store.getState().doc;
  const halves = [moved.editor.takes.s1b, moved.editor.takes.s1];
  const reordered = assembleNarration(halves, pcm);
  assert.deepEqual(reordered.subarray(0, 4000), samples.subarray(4000, 8000));
  assert.deepEqual(reordered.subarray(4000), samples.subarray(0, 4000));
  assert.equal(reordered.length, samples.length);
  store.undo();
  store.undo();
  assert.deepEqual(store.getState().doc.package, before.package);
  assert.deepEqual(store.getState().doc.editor, before.editor);
});

test('a caption that crosses the cut is divided and no cue still contains it', () => {
  const store = createEditorStore(speechDoc());
  const placed = placeScenes(store.getState().doc.package, { s1: store.getState().doc.editor.alignment.s1.chunks });
  assert.equal(placed.ok, true);
  const before = sentenceCues(store.getState().doc.editor.alignment.s1.chunks, placed.scenes[0].from, 's1', placed.fps);
  assert.equal(before.length, 1);
  assert.ok(before[0].from < 15 && before[0].to > 15);
  store.dispatch({ type: 'SplitScene', sceneId: 's1', frame: 15, newSceneId: 's1b' });
  const doc = store.getState().doc;
  assert.equal(doc.editor.alignment.s1.chunks[0].text, 'one two');
  assert.equal(doc.editor.alignment.s1b.chunks[0].text, 'three four');
  assert.equal(chunkCrosses(doc.editor.alignment.s1.chunks, doc.editor.alignment.s1.chunks[0].seconds), false);
  assert.equal(chunkCrosses(doc.editor.alignment.s1b.chunks, 0), false);
  const straddled = speechDoc();
  straddled.editor.alignment.s1.chunks = [{
    text: 'stay across',
    seconds: 1,
    words: [{ text: 'stay', start: 0, end: 0.4 }, { text: 'across', start: 0.4, end: 0.6 }],
  }];
  const cut = createEditorStore(straddled);
  cut.dispatch({ type: 'SplitScene', sceneId: 's1', frame: 15, newSceneId: 's1b' });
  const halves = cut.getState().doc;
  const texts = [halves.editor.alignment.s1.chunks[0].text, halves.editor.alignment.s1b.chunks[0].text];
  assert.equal(texts.filter(text => text.includes('across')).length, 1);
  assert.ok(halves.editor.alignment.s1.chunks[0].words.every(word => word.end <= halves.editor.alignment.s1.chunks[0].seconds + 1e-6));
});

test('editing narration text marks take, alignment and presenter stale and nothing else', () => {
  const store = createEditorStore(withSecondScene(speechDoc()));
  const still = structuredClone(store.getState().doc.package.assets.a_still);
  const bed = structuredClone(store.getState().doc.package.assets.a_bed);
  assert.deepEqual(staleWork(store.getState().doc), []);
  store.dispatch({ type: 'SetNarrationText', sceneId: 's1', text: 'one two three four changed' });
  const doc = store.getState().doc;
  assert.deepEqual(staleWork(doc), ['take:s1', 'alignment:s1', 'presenter:s1']);
  assert.deepEqual(staleAssets(doc), ['a_pres']);
  assert.equal(sceneStatus(doc, 's2').take, 'fresh');
  assert.equal(sceneStatus(doc, 's2').alignment, 'fresh');
  assert.equal(sceneStatus(doc, 's2').presenter, 'fresh');
  assert.deepEqual(doc.package.assets.a_still, still);
  assert.deepEqual(doc.package.assets.a_bed, bed);
  assert.equal(store.saveStatus(), 'pending');
  store.undo();
  assert.deepEqual(staleWork(store.getState().doc), []);
  assert.equal(store.saveStatus(), 'pending');
  store.noteSave({ type: 'ack', editSequence: store.getState().doc.editSequence, revision: 2 });
  assert.equal(store.saveStatus(), 'saved');
  store.dispatch({ type: 'SetSceneCopy', sceneId: 's1', copy: { headline: 'Renamed' } });
  assert.deepEqual(staleWork(store.getState().doc), []);
  store.dispatch({ type: 'SetCaptionText', sceneId: 's1', index: 0, text: 'one two three four.' });
  const corrected = store.getState();
  assert.equal(corrected.doc.package.scenes[0].narration, 'one two three four');
  assert.equal(corrected.derived.timeline.captions[0].text, 'one two three four.');
  assert.deepEqual(staleWork(corrected.doc), []);
});

test('changing the voice marks every narration take and not the picture or the bed', () => {
  const store = createEditorStore(withSecondScene(speechDoc()));
  store.dispatch({ type: 'SetVoice', voice: { enabled: true, engine: 'qwen3-tts', voice: 'clone', speed: 1, persona: 'calm' } });
  assert.deepEqual(staleWork(store.getState().doc), [
    'take:s1', 'alignment:s1', 'presenter:s1', 'take:s2', 'alignment:s2', 'presenter:s2',
  ]);
  assert.deepEqual(staleAssets(store.getState().doc), ['a_pres', 'a_pres2']);
});

test('sentence seek uses measured alignment frames', () => {
  const doc = speechDoc();
  doc.editor.alignment.s1.chunks = [
    { text: 'First.', seconds: 0.5 },
    { text: 'Second.', seconds: 0.5 },
  ];
  const placed = placeScenes(doc.package, { s1: doc.editor.alignment.s1.chunks });
  const cues = sentenceCues(doc.editor.alignment.s1.chunks, placed.scenes[0].from, 's1', placed.fps);
  assert.equal(seekFrameForSentence(cues, 1), cues[1].from);
  assert.ok(cues[1].from > cues[0].to);
});

test('audition mix params equal the renderer mix params', () => {
  const store = createEditorStore(speechDoc());
  const { doc, derived } = store.getState();
  const rendered = resolveAudioMix(doc.package, derived.timeline);
  const audition = auditionParams(doc.package, derived.timeline);
  assert.equal(audition.narrationGain, 1);
  assert.equal(audition.musicGainDb, rendered.music.gainDb);
  assert.equal(audition.musicGainDb, AUDIO_MIX_DEFAULTS.musicGainDb);
  assert.deepEqual(audition.musicDuck, rendered.music.duck);
  assert.deepEqual(audition.musicGains, rendered.music.gains);
  assert.equal(audition.musicLoop, rendered.music.loop);
  assert.deepEqual(audition.ambience, rendered.ambience);
  assert.deepEqual(audition.sfx.map(item => item.gainDb), rendered.sfx.map(item => item.gainDb));
  assert.equal(audition.musicGainDb, AUDIO_MIX_DEFAULTS.musicGainDb);
  assert.equal(store.saveStatus(), 'saved');
});

test('placement matches the planner for measured speech', () => {
  const doc = withSecondScene(speechDoc());
  doc.package.scenes[0].transitionOut = { type: 'fade', frames: 15 };
  const measured = {
    s1: doc.editor.alignment.s1.chunks,
    s2: doc.editor.alignment.s2.chunks,
  };
  const placed = placeScenes(doc.package, measured);
  const timeline = compileTimeline(doc.package, { narration: measured });
  assert.equal(placed.ok, true);
  assert.deepEqual(placed.scenes.map(scene => [scene.id, scene.from, scene.duration, scene.transitionOut]),
    timeline.scenes.map(scene => [scene.id, scene.from, scene.durationInFrames, scene.transitionOutFrames]));
  const cues = sentenceCues(measured.s1, placed.scenes[0].from, 's1', placed.fps);
  const plannerCues = timeline.captions.filter(cue => cue.sceneId === 's1');
  assert.deepEqual(cues.map(cue => [cue.text, cue.from, cue.to]), plannerCues.map(cue => [cue.text, cue.from, cue.to]));
});

test('voice preview uses a fixture and does not replace the selected voice', () => {
  const source = readFileSync(new URL('../src/editor/audio/voice-preview.ts', import.meta.url), 'utf8');
  assert.equal(source.includes('fetch('), false);
  assert.equal(source.includes('https:'), false);
  const stale = resolveVoicePreview({ engine: 'qwen3-tts', takeFresh: false });
  assert.equal(stale.kind, 'cpu-fixture');
  assert.equal(stale.replacesSelectedVoice, false);
  assert.match(stale.label, /not the selected Qwen voice/);
  const take = Float32Array.from([0.1, 0.2, 0.3]);
  const fresh = resolveVoicePreview({ engine: 'qwen3-tts', takeFresh: true, takeSamples: take, takeSampleRate: 8000 });
  assert.equal(fresh.kind, 'take');
  assert.deepEqual(fresh.samples, take);
  assert.equal(fresh.replacesSelectedVoice, false);
});

test('export sidecar omits tokens, tickets and audition state', () => {
  const store = createEditorStore(speechDoc());
  const token = 'test-token-0123456789abcdef';
  const sidecar = editorExportSidecar(store.getState().doc);
  assert.equal(containsSecret(sidecar, [token]), false);
  assert.equal(JSON.stringify(sidecar).includes('music'), false);
  assert.equal(mediaPlaybackUrl('ab'.repeat(16)).includes('token'), false);
  assert.throws(() => mediaPlaybackUrl(token), /Bad media ticket/);
});

test('waveforms are cached by source hash and computed off the main thread', async () => {
  clearWaveformCache();
  const samples = Float32Array.from({ length: 1000 }, (_, index) => Math.sin(index / 10));
  const worker = new Worker(new URL('../src/editor/audio/peaks-worker.mjs', import.meta.url));
  const port = {
    calls: 0,
    request(message) {
      this.calls += 1;
      return new Promise((resolve, reject) => {
        worker.once('message', data => resolve({ sourceHash: data.sourceHash, buckets: data.buckets, min: data.min, max: data.max }));
        worker.once('error', reject);
        worker.postMessage(message);
      });
    },
  };
  const peaks = await loadPeaks(port, samples, 'hash-wave', 10);
  const local = computePeaks(samples, 10);
  assert.deepEqual(peaks.min, local.min);
  assert.deepEqual(peaks.max, local.max);
  const again = await loadPeaks({ request: () => { throw new Error('cache miss'); } }, samples, 'hash-wave', 10);
  assert.equal(again, peaks);
  assert.equal(port.calls, 1);
  await worker.terminate();
});

function wavPcm(samples, sampleRate) {
  const data = Buffer.alloc(samples.length * 2);
  for (let index = 0; index < samples.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index]));
    data.writeInt16LE(Math.round(clamped * 32767), index * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

test('long media peaks come from byte windows, never one whole-file read', async () => {
  const count = 140000;
  const samples = Float32Array.from({ length: count }, (_, index) => Math.sin(index / 50));
  const file = wavPcm(samples, 8000);
  assert.ok(file.length > LONG_MEDIA_BYTES);
  const result = await peaksFromRangedWav({
    size: file.length,
    sourceHash: 'hash-long',
    buckets: 70,
    read: async (start, end) => {
      assert.ok(end - start + 1 < file.length);
      return new Uint8Array(file.subarray(start, end + 1));
    },
  });
  assert.ok(result.ranges.length > 2);
  assert.ok(result.ranges.every(([start, end]) => end - start + 1 <= 32 * 1024));
  const decoded = new Float32Array(count);
  for (let index = 0; index < count; index += 1) decoded[index] = file.readInt16LE(44 + index * 2) / 32768;
  const reference = peaksOfPcm(decoded, 'hash-long', 70);
  for (let bucket = 0; bucket < 70; bucket += 1) {
    assert.ok(Math.abs(result.peaks.min[bucket] - reference.min[bucket]) < 1 / 32768);
    assert.ok(Math.abs(result.peaks.max[bucket] - reference.max[bucket]) < 1 / 32768);
  }
});

test('a locked scene rejects a split with a reason', () => {
  const doc = speechDoc();
  doc.package.scenes[0].locked = true;
  const result = applyCommand({ ...doc, editSequence: 0 }, { type: 'SplitScene', sceneId: 's1', frame: 15, newSceneId: 's1b' });
  assert.equal(result.ok, false);
  assert.match(result.error, /locked/);
});

test('preview does not commit a split', () => {
  const store = createEditorStore(speechDoc());
  store.preview({ type: 'SplitScene', sceneId: 's1', frame: 15, newSceneId: 's1b' });
  assert.equal(store.getState().doc.package.scenes.length, 2);
  assert.equal(store.canUndo(), false);
  store.cancelPreview();
  assert.equal(store.getState().doc.package.scenes.length, 1);
  assert.equal(store.saveStatus(), 'saved');
});
