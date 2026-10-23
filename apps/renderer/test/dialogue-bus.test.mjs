/**
 * IP51D: a FastH3 native-dialogue plate lives on its own `dialogue` bus. The
 * composition, the incremental ffmpeg mix and the audition preview must all
 * consume it, at unity and never ducked by the narration. Pure test: the ffmpeg
 * calls are a stub first on PATH, so nothing here touches real media.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { muxPackageAudio, planAudioBuses } from '../scripts/incremental-audio.mjs';
import { AUDIO_MIX_DEFAULTS, resolveAudioMix } from '../src/audio-mix-model.js';
import { auditionParams } from '../../web/src/editor/audio/audition.ts';

const fps = 30;
const timeline = {
  fps,
  durationInFrames: 300,
  captions: [{ text: 'A line', from: 40, to: 80, sceneId: 's1' }],
  scenes: [
    { id: 's1', from: 0, durationInFrames: 150, transitionOutFrames: 0 },
    { id: 's2', from: 150, durationInFrames: 150, transitionOutFrames: 0 },
  ],
};

function plate(file, extra = {}) {
  return { kind: 'video', status: 'ready', file, media: { audio: 'present', frames: 90, fps: 24 }, ...extra };
}

const dialoguePlate = plate('assets/dialogue.mp4', {
  gen: {
    generator: 'fasth3-omni',
    direction: {
      subject: 'Pip',
      composition: 'head and shoulders',
      action: 'speaks to camera',
      camera: 'locked',
      soundscape: 'quiet room',
      characterCount: 1,
      dialogue: { text: 'A line', conditioningText: 'A line', language: 'en', voice: 'Pip', delivery: 'warm' },
    },
  },
});

const plainPlate = plate('assets/plate.mp4', { gen: { generator: 'ltx25' } });

/** One native-dialogue scene with an audio trim plus one plain plate. */
function dialoguePkg() {
  return {
    audio: { music: { asset: 'a_music', gain_db: -18 }, dialogue: { enabled: true }, ambience: {} },
    assets: { a_dialogue: dialoguePlate, a_plate: plainPlate, a_music: { kind: 'audio', status: 'ready', file: 'audio/music.wav' } },
    scenes: [
      {
        id: 's1',
        background: { asset: 'a_dialogue' },
        audio_trim: { offsetFrames: 15, startSeconds: 1.5, endSeconds: 3.5 },
      },
      { id: 's2', background: { asset: 'a_plate' } },
    ],
  };
}

test('a FastH3 dialogue plate plans a dialogue bus before ambience, with its exact window', () => {
  const buses = planAudioBuses({ pkg: dialoguePkg(), timeline });
  assert.deepEqual(buses.map(bus => bus.kind), ['music', 'dialogue', 'ambience']);
  assert.deepEqual(buses[1], {
    kind: 'dialogue',
    file: 'assets/dialogue.mp4',
    gainDb: AUDIO_MIX_DEFAULTS.dialogueGainDb,
    duck: { enabled: false, reductionDb: AUDIO_MIX_DEFAULTS.duckReductionDb, attackMs: AUDIO_MIX_DEFAULTS.duckAttackMs, releaseMs: AUDIO_MIX_DEFAULTS.duckReleaseMs },
    from: 15,
    seconds: 2,
    startSeconds: 1.5,
    endSeconds: 3.5,
  });
  assert.deepEqual(buses[2], {
    kind: 'ambience',
    file: 'assets/plate.mp4',
    gainDb: AUDIO_MIX_DEFAULTS.ambienceGainDb,
    duck: { enabled: true, reductionDb: AUDIO_MIX_DEFAULTS.duckReductionDb, attackMs: AUDIO_MIX_DEFAULTS.duckAttackMs, releaseMs: AUDIO_MIX_DEFAULTS.duckReleaseMs },
    from: 150,
    seconds: 5,
  });
});

test('a package with no dialogue plates plans exactly the previous music/ambience/sfx buses', () => {
  const pkg = {
    audio: { music: { asset: 'a_music', gain_db: -18 }, ambience: {}, sfx: [{ asset: 'a_sfx', scene: 's1', at: 'scene-start' }] },
    assets: {
      a_music: { kind: 'audio', status: 'ready', file: 'audio/music.wav' },
      a_plate: plainPlate,
      a_sfx: { kind: 'audio', status: 'ready', file: 'audio/sfx.wav', media: { durationSeconds: 0.3 } },
    },
    scenes: [
      { id: 's1', background: { asset: 'a_plate' } },
      { id: 's2', background: { asset: 'a_plate' } },
    ],
  };
  const duck = { enabled: true, reductionDb: AUDIO_MIX_DEFAULTS.duckReductionDb, attackMs: AUDIO_MIX_DEFAULTS.duckAttackMs, releaseMs: AUDIO_MIX_DEFAULTS.duckReleaseMs };
  assert.deepEqual(planAudioBuses({ pkg, timeline }), [
    { kind: 'music', file: 'audio/music.wav', gainDb: -18, duck, loop: true, fadeIn: 0, fadeOut: 0 },
    { kind: 'ambience', file: 'assets/plate.mp4', gainDb: AUDIO_MIX_DEFAULTS.ambienceGainDb, duck, from: 0, seconds: 5 },
    { kind: 'ambience', file: 'assets/plate.mp4', gainDb: AUDIO_MIX_DEFAULTS.ambienceGainDb, duck, from: 150, seconds: 5 },
    { kind: 'sfx', file: 'audio/sfx.wav', gainDb: AUDIO_MIX_DEFAULTS.sfxGainDb, from: 0, seconds: 0.3 },
  ]);
  assert.deepEqual(planAudioBuses({ pkg: dialoguePkg(), timeline, mixAudio: false }), []);
});

test('audition carries the dialogue frames, gains and source window from the renderer mix', () => {
  const pkg = dialoguePkg();
  const mix = resolveAudioMix(pkg, timeline);
  const audition = auditionParams(pkg, timeline);
  assert.equal(audition.dialogue.length, 1);
  assert.deepEqual(audition.dialogue, mix.dialogue.map(item => ({
    sceneId: item.sceneId,
    gainDb: item.gainDb,
    from: item.from,
    durationInFrames: item.durationInFrames,
    gains: item.gains,
    ...(typeof item.startSeconds === 'number' ? { startSeconds: item.startSeconds } : {}),
    ...(typeof item.endSeconds === 'number' ? { endSeconds: item.endSeconds } : {}),
  })));
  const [dialogue] = audition.dialogue;
  assert.equal(dialogue.from, 15);
  assert.equal(dialogue.durationInFrames, 60);
  assert.equal(dialogue.gains.length, 60);
  assert.equal(dialogue.startSeconds, 1.5);
  assert.equal(dialogue.endSeconds, 3.5);
  assert.ok(dialogue.gains.every(gain => Math.abs(gain - 1) < 1e-9), 'dialogue stays at unity');
});

test('the incremental mux feeds the dialogue bus without sidechaining it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dialogue-bus-'));
  const bin = join(dir, 'bin');
  const log = join(dir, 'ffmpeg-args.log');
  const previousPath = process.env.PATH;
  try {
    mkdirSync(bin, { recursive: true });
    mkdirSync(join(dir, 'audio'), { recursive: true });
    mkdirSync(join(dir, 'assets'), { recursive: true });
    writeFileSync(join(dir, 'assets', 'dialogue.mp4'), '');
    writeFileSync(join(dir, 'assets', 'plate.mp4'), '');
    writeFileSync(join(dir, 'audio', 'narration.wav'), '');
    writeFileSync(join(dir, 'silent.mp4'), '');
    const stub = (name, body) => {
      const file = join(bin, name);
      writeFileSync(file, `#!/bin/sh\n${body}\nexit 0\n`);
      chmodSync(file, 0o755);
    };
    stub('ffmpeg', `printf '%s\\n' "$@" > "${log}"`);
    stub('ffprobe', `printf '%s' '{"streams":[]}'`);
    process.env.PATH = `${bin}:${previousPath ?? ''}`;

    const pkg = {
      audio: { dialogue: { enabled: true }, ambience: {} },
      assets: {
        a_dialogue: { ...dialoguePlate, file: 'assets/dialogue.mp4' },
        a_plate: { ...plainPlate, file: 'assets/plate.mp4' },
        a_narr: { kind: 'audio', status: 'ready', file: 'audio/narration.wav' },
      },
      scenes: [
        { id: 's1', background: { asset: 'a_dialogue' }, narration_asset: 'a_narr' },
        { id: 's2', background: { asset: 'a_plate' } },
      ],
    };
    const muxTimeline = {
      fps: 10,
      durationInFrames: 30,
      captions: [{ from: 2, to: 8 }],
      scenes: [
        { id: 's1', from: 0, durationInFrames: 15, transitionOutFrames: 0 },
        { id: 's2', from: 15, durationInFrames: 15, transitionOutFrames: 0 },
      ],
    };
    const result = muxPackageAudio({
      silentPath: join(dir, 'silent.mp4'),
      outputPath: join(dir, 'out.mp4'),
      packageDir: dir,
      pkg,
      timeline: muxTimeline,
    });
    assert.equal(result.audio.sources, 3);

    const args = readFileSync(log, 'utf8').split('\n').filter(Boolean);
    assert.notEqual(args.indexOf(join(dir, 'assets', 'dialogue.mp4')), -1, 'dialogue file is an input');
    const graph = args[args.indexOf('-filter_complex') + 1];
    assert.match(graph, /\[2:a\]volume=/, 'the dialogue input has its own gain chain');
    assert.match(graph, /\[b0\]/, 'the dialogue label is mixed');
    assert.doesNotMatch(graph, /\[b0\][^;]*sidechaincompress/, 'dialogue is never sidechained');
    assert.match(graph, /\[b1\][^;]*sidechaincompress/, 'ambience is still ducked under the narration');
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    rmSync(dir, { recursive: true, force: true });
  }
});
