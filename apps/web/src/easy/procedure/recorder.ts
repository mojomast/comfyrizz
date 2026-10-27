// Tab recording with the browser's own Screen Capture and MediaRecorder APIs.
//
// getDisplayMedia needs a user gesture and asks every time; nothing here can
// pre-approve it. Audio stays off so no microphone or system sound is taken.
// Chrome and Edge 126+ can write MP4 directly; other browsers write WebM, which
// scripts/capture-procedure.mjs --assemble turns into an MP4.

export const RECORDING_MIME_CANDIDATES = Object.freeze([
  'video/mp4;codecs=avc1.640028',
  'video/mp4;codecs=avc1.42E01E',
  'video/mp4',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
]);

const VIDEO_BITS_PER_SECOND = 5_000_000;
const TIMESLICE_MS = 1000;

interface TrackLike {
  stop(): void;
  getSettings?(): { displaySurface?: string };
  addEventListener?(type: 'ended', listener: () => void): void;
}

interface StreamLike {
  getTracks(): TrackLike[];
  getVideoTracks?(): TrackLike[];
}

interface RecorderLike {
  readonly mimeType?: string;
  state?: string;
  ondataavailable: ((event: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
  onerror?: ((event: unknown) => void) | null;
  start(timeslice?: number): void;
  stop(): void;
}

interface RecorderConstructor {
  new (stream: StreamLike, options?: { mimeType?: string; videoBitsPerSecond?: number }): RecorderLike;
  isTypeSupported?(mimeType: string): boolean;
}

export interface TabRecorderEnv {
  mediaDevices?: { getDisplayMedia?(constraints: unknown): Promise<StreamLike> } | null;
  MediaRecorder?: RecorderConstructor | null;
}

export type TabRecordingFailure = 'unsupported' | 'denied';

export interface TabRecording {
  ok: true;
  mimeType: string;
  /** False when the person shared a window or screen instead of a tab. */
  thisTabOnly: boolean;
  stop(): Promise<Blob>;
}

export type StartTabRecordingResult = TabRecording | { ok: false; reason: TabRecordingFailure; detail: string };

export interface StartTabRecordingOptions {
  /** Screen sharing ended from the browser's own "Stop sharing" control. */
  onEnded?(): void;
}

export function browserRecorderEnv(): TabRecorderEnv {
  const scope = globalThis as unknown as {
    navigator?: { mediaDevices?: TabRecorderEnv['mediaDevices'] };
    MediaRecorder?: RecorderConstructor;
  };
  return { mediaDevices: scope.navigator?.mediaDevices ?? null, MediaRecorder: scope.MediaRecorder ?? null };
}

/** The first recordable type, preferring MP4 so most recordings need no conversion. */
export function pickRecordingMime(isTypeSupported: ((mime: string) => boolean) | undefined): string {
  if (typeof isTypeSupported !== 'function') return '';
  for (const mime of RECORDING_MIME_CANDIDATES) {
    try {
      if (isTypeSupported(mime)) return mime;
    } catch {
      /* a throwing probe means the type is not supported */
    }
  }
  return '';
}

export function extensionForMime(mime: string): 'mp4' | 'webm' {
  return /^video\/mp4/iu.test(mime) ? 'mp4' : 'webm';
}

/** Surfaces: prefer this tab, never offer whole monitors first, keep the shared tab fixed. */
export const DISPLAY_MEDIA_CONSTRAINTS = Object.freeze({
  video: { displaySurface: 'browser', frameRate: { ideal: 30, max: 30 } },
  audio: false,
  preferCurrentTab: true,
  selfBrowserSurface: 'include',
  surfaceSwitching: 'exclude',
  monitorTypeSurfaces: 'exclude',
});

function errorName(error: unknown): string {
  if (error && typeof error === 'object' && typeof (error as { name?: unknown }).name === 'string') {
    return (error as { name: string }).name;
  }
  return '';
}

/**
 * Ask to share this tab and start recording it. Call this from the click
 * handler itself: the browser rejects the request without a fresh gesture.
 */
export async function startTabRecording(
  env: TabRecorderEnv = browserRecorderEnv(),
  options: StartTabRecordingOptions = {},
): Promise<StartTabRecordingResult> {
  const getDisplayMedia = env.mediaDevices?.getDisplayMedia;
  const Recorder = env.MediaRecorder;
  if (typeof getDisplayMedia !== 'function' || typeof Recorder !== 'function') {
    return { ok: false, reason: 'unsupported', detail: 'getDisplayMedia or MediaRecorder is missing' };
  }

  let stream: StreamLike;
  try {
    stream = await getDisplayMedia.call(env.mediaDevices, DISPLAY_MEDIA_CONSTRAINTS);
  } catch (error) {
    const name = errorName(error);
    const reason: TabRecordingFailure = name === 'NotSupportedError' || name === 'TypeError' ? 'unsupported' : 'denied';
    return { ok: false, reason, detail: name || 'getDisplayMedia failed' };
  }

  const stopTracks = (): void => {
    for (const track of stream.getTracks()) {
      try {
        track.stop();
      } catch {
        /* already stopped */
      }
    }
  };

  const mime = pickRecordingMime(Recorder.isTypeSupported?.bind(Recorder));
  let recorder: RecorderLike;
  try {
    recorder = new Recorder(stream, {
      ...(mime === '' ? {} : { mimeType: mime }),
      videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
    });
  } catch (error) {
    stopTracks();
    return { ok: false, reason: 'unsupported', detail: errorName(error) || 'MediaRecorder could not start' };
  }

  const video = (stream.getVideoTracks?.() ?? stream.getTracks())[0];
  const surface = video?.getSettings?.().displaySurface;
  const chunks: Blob[] = [];
  let finished: Promise<Blob> | null = null;
  let resolveFinished: ((blob: Blob) => void) | null = null;
  const mimeType = recorder.mimeType || mime || 'video/webm';

  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) chunks.push(event.data);
  };
  recorder.onstop = () => {
    stopTracks();
    resolveFinished?.(new Blob(chunks, { type: mimeType.split(';')[0] }));
  };

  video?.addEventListener?.('ended', () => {
    if (recorder.state !== 'inactive') options.onEnded?.();
  });

  try {
    recorder.start(TIMESLICE_MS);
  } catch (error) {
    stopTracks();
    return { ok: false, reason: 'unsupported', detail: errorName(error) || 'MediaRecorder could not start' };
  }

  return {
    ok: true,
    mimeType,
    thisTabOnly: surface === undefined || surface === 'browser',
    stop(): Promise<Blob> {
      if (finished) return finished;
      finished = new Promise<Blob>((resolve) => {
        resolveFinished = resolve;
      });
      if (recorder.state === 'inactive') {
        stopTracks();
        resolveFinished?.(new Blob(chunks, { type: mimeType.split(';')[0] }));
      } else {
        recorder.stop();
      }
      return finished;
    },
  };
}
