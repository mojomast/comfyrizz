/**
 * Deterministic FLUX caption expansion for planned image jobs (spec 6.4).
 *
 * GPU test 2 findings baked in (docs/GPU_TEST_2.md):
 *  - Klein draws garbled pseudo-text on screens and stray words, so a still
 *    suppresses text unless the caller explicitly wants it (`text: true`).
 *  - Frames that carry labels must ask for a static camera; a push-in or orbit
 *    pushes labels out of frame.
 *  - i2v source stills must be generated at the output aspect, otherwise the
 *    first frame is centre-cropped when it reaches LTX.
 */
export type Aspect = '16:9' | '1:1' | '4:5' | '9:16';

export interface CaptionInput {
  intent: string;
  palette?: string[];
  style?: string;
  aspect?: Aspect;
  cutout?: boolean;
  /** The still may carry text; omit the "no text" clause. */
  text?: boolean;
  /** The still feeds a labelled diagram/animation: keep labels and lock the camera. */
  labelled?: boolean;
}

/** Default negative prompt. "no letters" is explicit: Klein writes stray words otherwise. */
const NEGATIVE = 'no text, no letters, no words, no logos, no watermarks, no UI chrome';
const KEEP_TEXT = 'legible labels only, no extra text beyond the supplied labels';
const STATIC_CAMERA = 'static camera, no camera movement';

const FRAMING: Record<Aspect, string> = {
  '16:9': 'wide 16:9 composition',
  '1:1': 'square composition',
  '4:5': 'portrait composition',
  '9:16': 'vertical composition',
};

/** Pick the output aspect from package dimensions (defaults to 16:9). */
export function aspectFromSize(width?: number, height?: number): Aspect {
  if (!width || !height) return '16:9';
  const ratio = width / height;
  if (Math.abs(ratio - 1) < 0.05) return '1:1';
  if (Math.abs(ratio - 4 / 5) < 0.05) return '4:5';
  if (Math.abs(ratio - 9 / 16) < 0.05) return '9:16';
  return '16:9';
}

/** FLUX source dimensions for an aspect; i2v sources must match the output. */
export function sourceDims(aspect: Aspect): { width: number; height: number } {
  switch (aspect) {
    case '1:1':
      return { width: 1024, height: 1024 };
    case '4:5':
      return { width: 864, height: 1080 };
    case '9:16':
      return { width: 576, height: 1024 };
    default:
      return { width: 1024, height: 576 };
  }
}

export function expandFluxCaption(input: CaptionInput): string {
  const palette = input.palette?.length ? `palette ${input.palette.join(', ')}` : 'a restrained launch palette';
  const style = input.style ?? 'editorial 3D render, soft volumetric light, subtle grain';
  const aspect = input.aspect ?? '16:9';
  const framing = FRAMING[aspect];
  const cutout = input.cutout ? 'isolated subject on a transparent background, clean silhouette' : 'full-bleed scene';
  const camera = input.labelled ? `; ${STATIC_CAMERA}` : '';
  const text = input.text || input.labelled ? KEEP_TEXT : NEGATIVE;
  return `${input.intent.trim().replace(/[.!?]+$/, '')}. ${style}; ${palette}; ${framing}; ${cutout}${camera}; ${text}.`;
}

export interface ReferenceEditCaptionInput {
  intent: string;
  /** Target style, e.g. clay, glass, editorial. */
  style?: string;
  palette?: string[];
  aspect?: Aspect;
}

/**
 * Klein reference-edit caption (GPU test 2, "Best prompt templates"): the SVG
 * raster is image0 and the graph keeps layout, positions and labels while it
 * restyles the surface. The template is deliberately explicit about keeping
 * every label, because the edit is what makes an agent SVG look finished.
 */
export function expandReferenceEditCaption(input: ReferenceEditCaptionInput): string {
  const subject = input.intent.trim().replace(/[.!?]+$/, '');
  const style = input.style?.trim() || 'clay';
  const palette = input.palette?.length ? `palette ${input.palette.join(', ')}` : 'the source palette';
  const framing = FRAMING[input.aspect ?? '16:9'];
  return (
    `Restyle this ${subject} as ${style}; ${palette}; ${framing}. ` +
    'Keep the exact layout, positions, colours and all labels exactly as written. ' +
    'Do not add or remove elements.'
  );
}

export interface VideoCaptionInput {
  intent: string;
  /** i2v: use the supplied still as the first frame. */
  startImage?: boolean;
  /** The frame carries labels; lock the camera and suppress motion words. */
  labelled?: boolean;
  /** Explicit gentle motion for unlabelled frames. */
  motion?: 'idle' | 'glow-pulse' | 'light-sweep' | 'drift';
  /** Allow text (rare for video). */
  text?: boolean;
}

const MOTION: Record<NonNullable<VideoCaptionInput['motion']>, string> = {
  idle: 'gentle idle breathing',
  'glow-pulse': 'a soft glow pulse',
  'light-sweep': 'a slow light sweep',
  drift: 'a slow steady drift',
};

/**
 * LTX caption expansion. Labelled frames get a static camera and no push-in or
 * orbit (GPU test 2: push-ins pushed labels out of frame).
 */
export function expandVideoCaption(input: VideoCaptionInput): string {
  const lead = input.startImage ? 'Use the provided start image as the first frame.' : '';
  const motion = input.labelled ? 'one subtle pulse, no geometry change' : MOTION[input.motion ?? 'drift'];
  const camera = 'static camera, no cuts';
  const text = input.text ? 'legible labels only' : 'no text';
  return [lead, `${input.intent.trim().replace(/[.!?]+$/, '')}.`, `One gentle motion: ${motion}.`, `${camera}.`, `${text}.`].filter(Boolean).join(' ');
}
