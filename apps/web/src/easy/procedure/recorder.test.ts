// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DISPLAY_MEDIA_CONSTRAINTS,
  extensionForMime,
  pickRecordingMime,
  startTabRecording,
} from './recorder.ts';

function fakeStream(surface = 'browser') {
  const listeners = {};
  const track = {
    stopped: false,
    stop() {
      this.stopped = true;
    },
    getSettings: () => ({ displaySurface: surface }),
    addEventListener(type, listener) {
      listeners[type] = listener;
    },
  };
  return {
    track,
    end: () => listeners.ended?.(),
    getTracks: () => [track],
    getVideoTracks: () => [track],
  };
}

function fakeRecorderClass(supported = (mime) => mime === 'video/webm;codecs=vp9') {
  const instances = [];
  class FakeRecorder {
    static isTypeSupported(mime) {
      return supported(mime);
    }
    constructor(stream, options) {
      this.stream = stream;
      this.options = options;
      this.mimeType = options?.mimeType ?? '';
      this.state = 'inactive';
      this.ondataavailable = null;
      this.onstop = null;
      instances.push(this);
    }
    start(timeslice) {
      this.timeslice = timeslice;
      this.state = 'recording';
    }
    emit(text) {
      this.ondataavailable?.({ data: new Blob([text]) });
    }
    stop() {
      this.state = 'inactive';
      queueMicrotask(() => this.onstop?.());
    }
  }
  return { FakeRecorder, instances };
}

test('MP4 is preferred when the browser can write it, then WebM', () => {
  assert.equal(pickRecordingMime((mime) => mime.startsWith('video/mp4')), 'video/mp4;codecs=avc1.640028');
  assert.equal(pickRecordingMime((mime) => mime === 'video/webm;codecs=vp8'), 'video/webm;codecs=vp8');
  assert.equal(pickRecordingMime(() => false), '');
  assert.equal(pickRecordingMime(() => {
    throw new Error('probe');
  }), '');
  assert.equal(pickRecordingMime(undefined), '');
  assert.equal(extensionForMime('video/mp4;codecs=avc1'), 'mp4');
  assert.equal(extensionForMime('video/webm'), 'webm');
  assert.equal(extensionForMime(''), 'webm');
});

test('the share request prefers this tab and never asks for audio', () => {
  assert.equal(DISPLAY_MEDIA_CONSTRAINTS.preferCurrentTab, true);
  assert.equal(DISPLAY_MEDIA_CONSTRAINTS.audio, false);
  assert.equal(DISPLAY_MEDIA_CONSTRAINTS.video.displaySurface, 'browser');
  assert.equal(DISPLAY_MEDIA_CONSTRAINTS.monitorTypeSurfaces, 'exclude');
});

test('a browser without screen capture reports unsupported', async () => {
  assert.equal((await startTabRecording({ mediaDevices: null, MediaRecorder: null })).reason, 'unsupported');
  const { FakeRecorder } = fakeRecorderClass();
  assert.equal((await startTabRecording({ mediaDevices: {}, MediaRecorder: FakeRecorder })).reason, 'unsupported');
});

test('a refused share reports denied and a headless refusal reports unsupported', async () => {
  const { FakeRecorder } = fakeRecorderClass();
  const denied = await startTabRecording({
    mediaDevices: { getDisplayMedia: async () => { throw Object.assign(new Error('no'), { name: 'NotAllowedError' }); } },
    MediaRecorder: FakeRecorder,
  });
  assert.deepEqual(denied, { ok: false, reason: 'denied', detail: 'NotAllowedError' });
  const headless = await startTabRecording({
    mediaDevices: { getDisplayMedia: async () => { throw Object.assign(new Error('no'), { name: 'NotSupportedError' }); } },
    MediaRecorder: FakeRecorder,
  });
  assert.equal(headless.reason, 'unsupported');
});

test('recording collects chunks into one blob and stops the shared tab', async () => {
  const stream = fakeStream();
  const { FakeRecorder, instances } = fakeRecorderClass();
  let asked = null;
  const result = await startTabRecording({
    mediaDevices: { getDisplayMedia: async (constraints) => { asked = constraints; return stream; } },
    MediaRecorder: FakeRecorder,
  });
  assert.equal(result.ok, true);
  assert.equal(asked, DISPLAY_MEDIA_CONSTRAINTS);
  assert.equal(result.mimeType, 'video/webm;codecs=vp9');
  assert.equal(result.thisTabOnly, true);
  const recorder = instances[0];
  assert.equal(recorder.timeslice, 1000);
  recorder.emit('abc');
  recorder.emit('');
  recorder.emit('def');
  const first = result.stop();
  assert.equal(result.stop(), first, 'stop is idempotent');
  const blob = await first;
  assert.equal(blob.type, 'video/webm');
  assert.equal(await blob.text(), 'abcdef');
  assert.equal(stream.track.stopped, true);
});

test('sharing a whole screen is flagged and the browser stop control is reported', async () => {
  const stream = fakeStream('monitor');
  const { FakeRecorder } = fakeRecorderClass();
  let ended = 0;
  const result = await startTabRecording({
    mediaDevices: { getDisplayMedia: async () => stream },
    MediaRecorder: FakeRecorder,
  }, { onEnded: () => { ended += 1; } });
  assert.equal(result.thisTabOnly, false);
  stream.end();
  assert.equal(ended, 1);
  await result.stop();
});
