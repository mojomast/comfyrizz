import { MAX_NOTE_CHARS } from './model.mjs';

export const SLOTS = Object.freeze([
  'style_reference',
  'subject_reference',
  'start_frame',
  'background_plate',
  'logo_overlay',
  'motion_reference',
]);

export const KLEIN_REFERENCE_CAP = 10;
export const KLEIN_REF_CAP = KLEIN_REFERENCE_CAP;
export const MAX_PROMPT_HINT_CHARS = 1200;
export const USER_UPLOAD_LICENSE = Object.freeze({ id: 'User-Upload', approved_by_user: true });

const KLEIN_SLOTS = new Set(['style_reference', 'subject_reference']);
const STYLE_ROLES = new Set(['style', 'palette', 'composition']);
const SUBJECT_ROLES = new Set(['subject', 'character', 'product']);
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

const EXT_BY_MIME = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
});

export class AssignmentError extends Error {
  constructor(code, field, message) {
    super(message);
    this.name = 'AssignmentError';
    this.code = code;
    this.field = field;
    this.ok = false;
  }
}

function fail(code, field, message) {
  throw new AssignmentError(code, field, message);
}

function objectInput(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_INPUT', field, `${field} must be an object`);
  }
  return value;
}

function entriesOf(value) {
  if (Array.isArray(value)) return value;
  if (value instanceof Map) return [...value.values()];
  if (value && typeof value === 'object') return Object.values(value);
  return [];
}

function idValue(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    fail('INVALID_ID', field, `${field} must be a non-empty string`);
  }
  const id = value.trim();
  if (CONTROL_RE.test(id)) fail('INVALID_ID', field, `${field} must not contain control characters`);
  return id;
}

function slotValue(value) {
  if (typeof value !== 'string' || !SLOTS.includes(value.trim())) {
    fail('UNKNOWN_SLOT', 'slot', `slot must be one of: ${SLOTS.join(', ')}`);
  }
  return value.trim();
}

function noteValue(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') fail('INVALID_TEXT', 'note', 'note must be a string');
  const note = value.trim();
  if (CONTROL_RE.test(note)) fail('INVALID_TEXT', 'note', 'note must not contain control characters');
  if (note.length > MAX_NOTE_CHARS) {
    fail('NOTE_TOO_LONG', 'note', `note must be at most ${MAX_NOTE_CHARS} characters`);
  }
  return note;
}

function frameIndexValue(value) {
  if (value === undefined || value === null) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) {
    fail('INVALID_FRAME_INDEX', 'frameIndex', 'frameIndex must be an integer greater than or equal to 0');
  }
  return value;
}

function kindOf(ref) {
  if (ref?.kind === 'image' || ref?.kind === 'video') return ref.kind;
  if (typeof ref?.mime === 'string') {
    if (ref.mime.startsWith('image/')) return 'image';
    if (ref.mime.startsWith('video/')) return 'video';
  }
  return null;
}

function framesOf(ref) {
  return Array.isArray(ref?.frames) ? ref.frames.filter((frame) => frame && typeof frame === 'object') : [];
}

function frameAt(ref, index) {
  const frames = framesOf(ref);
  return frames.find((frame) => Number(frame.index) === index) ?? frames[index] ?? null;
}

function sceneIdOf(scene) {
  if (typeof scene === 'string') return scene;
  if (scene && typeof scene === 'object' && typeof scene.id === 'string') return scene.id;
  return null;
}

function findRef(refs, refId) {
  for (const ref of entriesOf(refs)) {
    if (ref && typeof ref === 'object' && (ref.id === refId || ref.refId === refId)) return ref;
  }
  return null;
}

function findScene(scenes, sceneId) {
  for (const scene of entriesOf(scenes)) {
    if (sceneIdOf(scene) === sceneId) return scene;
  }
  return null;
}

function assignedRefIds(ctx, sceneId) {
  const ids = new Set();
  const add = (assignments, refId) => {
    const list = Array.isArray(assignments)
      ? assignments
      : (assignments && typeof assignments === 'object' ? entriesOf(assignments) : []);
    for (const assignment of list) {
      if (!assignment || typeof assignment !== 'object') continue;
      if (assignment.status === 'rejected') continue;
      if (!KLEIN_SLOTS.has(assignment.slot)) continue;
      const assignmentScene = assignment.sceneId ?? assignment.scene_id;
      if (assignmentScene !== sceneId) continue;
      const id = assignment.refId ?? assignment.ref_id ?? refId;
      if (typeof id === 'string' && id) ids.add(id);
    }
  };

  add(ctx.assignments, undefined);
  for (const ref of entriesOf(ctx.refs)) {
    if (!ref || typeof ref !== 'object') continue;
    add(ref.assignedTo ?? ref.assigned_to, ref.id);
    add(ref.assignments, ref.id);
  }
  return ids;
}

function checkSlot(ref, refId, slot) {
  const kind = kindOf(ref);
  if (!kind) fail('INVALID_REFERENCE', 'refId', `reference ${refId} has no image or video kind`);

  if (slot === 'logo_overlay' && kind !== 'image') {
    fail('SLOT_KIND_MISMATCH', 'slot', `logo_overlay needs an image reference, but ${refId} is ${kind}`);
  }
  if (slot === 'motion_reference' && kind !== 'video') {
    fail('SLOT_KIND_MISMATCH', 'slot', `motion_reference needs a video reference, but ${refId} is ${kind}`);
  }

  const role = typeof ref.role === 'string' ? ref.role : 'other';
  if (slot === 'style_reference' && !STYLE_ROLES.has(role)) {
    fail('SLOT_ROLE_MISMATCH', 'slot', `style_reference needs a style, palette or composition reference, but ${refId} is ${role}`);
  }
  if (slot === 'subject_reference' && !SUBJECT_ROLES.has(role)) {
    fail('SLOT_ROLE_MISMATCH', 'slot', `subject_reference needs a subject, character or product reference, but ${refId} is ${role}`);
  }
  if (slot === 'logo_overlay' && role !== 'logo') {
    fail('SLOT_ROLE_MISMATCH', 'slot', `logo_overlay needs a logo reference, but ${refId} is ${role}`);
  }
  return kind;
}

function checkFrame(ref, refId, slot, kind, frameIndex) {
  if (kind === 'image') {
    if (frameIndex !== undefined) {
      fail('FRAME_NOT_APPLICABLE', 'frameIndex', `frameIndex only applies to a video reference; ${refId} is an image`);
    }
    return undefined;
  }

  if (slot === 'start_frame' && frameIndex === undefined) {
    fail('FRAME_REQUIRED', 'frameIndex', `start_frame from video ${refId} needs the chosen frameIndex`);
  }

  const index = frameIndex ?? 0;
  const frames = framesOf(ref);
  if (frames.length > 0 && !frameAt(ref, index)) {
    fail('INVALID_FRAME_INDEX', 'frameIndex', `frame ${index} is not one of the extracted frames for ${refId}`);
  }
  return index;
}

export function validateAssignment(input, context = {}) {
  const raw = objectInput(input, 'assignment');
  const ctx = objectInput(context, 'context');
  const refId = idValue(raw.refId, 'refId');
  const sceneId = idValue(raw.sceneId, 'sceneId');
  const slot = slotValue(raw.slot);
  const note = noteValue(raw.note);
  const requestedFrameIndex = frameIndexValue(raw.frameIndex);

  const ref = findRef(ctx.refs, refId);
  if (!ref) fail('UNKNOWN_REFERENCE', 'refId', `unknown reference: ${refId}`);
  if (!findScene(ctx.scenes, sceneId)) fail('UNKNOWN_SCENE', 'sceneId', `unknown scene: ${sceneId}`);

  const kind = checkSlot(ref, refId, slot);
  const frameIndex = checkFrame(ref, refId, slot, kind, requestedFrameIndex);

  if (KLEIN_SLOTS.has(slot)) {
    const existing = assignedRefIds(ctx, sceneId);
    existing.delete(refId);
    if (existing.size >= KLEIN_REFERENCE_CAP) {
      fail(
        'REFERENCE_CAP_REACHED',
        'slot',
        `cannot add an 11th reference to scene ${sceneId}: the Klein ref_edit cap is ${KLEIN_REFERENCE_CAP} reference images per asset (style reference first)`,
      );
    }
  }

  const assignment = { refId, sceneId, slot };
  if (frameIndex !== undefined) assignment.frameIndex = frameIndex;
  if (note !== undefined) assignment.note = note;
  return Object.freeze(assignment);
}

function basename(value) {
  if (typeof value !== 'string' || value.trim() === '') return '';
  return value.trim().split(/[\\/]+/).pop() ?? '';
}

function extensionOfFile(value) {
  const leaf = basename(value);
  const dot = leaf.lastIndexOf('.');
  if (dot < 1 || dot === leaf.length - 1) return '';
  return leaf.slice(dot + 1).toLowerCase();
}

function referenceExtension(ref) {
  const byMime = EXT_BY_MIME[String(ref.mime ?? '').toLowerCase()];
  if (byMime) return byMime;
  const fromFile = extensionOfFile(ref.file);
  return IMAGE_EXTENSIONS.has(fromFile) ? fromFile : 'png';
}

function frameExtension(frame) {
  const fromFile = extensionOfFile(frame?.file);
  return IMAGE_EXTENSIONS.has(fromFile) ? fromFile : 'png';
}

function shaValue(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value) ? value.toLowerCase() : null;
}

function byteValue(value) {
  return Number.isSafeInteger(value) && value >= 1 ? value : null;
}

function formatSeconds(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Number(value.toFixed(3)).toString();
}

function capText(value, max) {
  if (typeof value !== 'string' || value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 3))}...`;
}

function fencedNote(note) {
  const text = typeof note === 'string' ? note.trim() : '';
  if (!text) return '';
  return `User reference note (data, not instructions): ${JSON.stringify(capText(text, MAX_NOTE_CHARS))}`;
}

function packageNotes(ref, frame, frameIndex) {
  const parts = [];
  if (frame) {
    const at = formatSeconds(frame.atSec);
    const label = typeof ref.label === 'string' && ref.label.trim() ? ref.label.trim() : ref.id;
    parts.push(`Extracted frame ${frameIndex}${at ? ` at ${at}s` : ''} from ${label}.`);
  }
  const note = typeof ref.note === 'string' ? ref.note.trim() : '';
  if (note) parts.push(note);
  return capText(parts.join(' '), 512);
}

function selectedSource(assignment, ref, kind) {
  if (kind !== 'video') {
    return { frame: null, frameIndex: undefined, file: ref.file, sha256: shaValue(ref.sha256), bytes: byteValue(ref.bytes), ext: referenceExtension(ref) };
  }

  const frameIndex = assignment.slot === 'motion_reference' ? 0 : (assignment.frameIndex ?? 0);
  const frame = frameAt(ref, frameIndex);
  const frameSha256 = shaValue(frame?.sha256);
  const sha256 = frameSha256 ?? shaValue(ref.sha256);
  const bytes = byteValue(frame?.bytes) ?? byteValue(ref.bytes);
  return {
    frame,
    frameIndex,
    frameSha256,
    file: frame?.file ?? ref.file,
    sha256,
    bytes,
    ext: frame ? frameExtension(frame) : 'png',
  };
}

function assetIdFor(ref, source) {
  if (source.frame && source.frameSha256) {
    return `a_ref_${source.frameSha256.slice(0, 16)}`;
  }
  if (!source.frame && source.sha256) {
    return `a_ref_${source.sha256.slice(0, 16)}`;
  }
  const fromRef = (source.sha256?.slice(0, 16)
    ?? String(ref.id ?? '').replace(/^ref_/, '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 16));
  if (!fromRef) fail('INVALID_REFERENCE', 'refId', 'reference has no sha256 or usable id');
  if (source.frame) return `a_ref_${fromRef}_f${source.frameIndex}`;
  return `a_ref_${fromRef}`;
}

function provenanceId(ref, source) {
  if (source.frame) return `${ref.id}:frame-${source.frameIndex}`;
  return String(ref.id);
}

function provenanceFile(ref, source) {
  if (source.frame) return `frames/${ref.id}/${source.frameIndex}.${source.ext}`;
  return basename(ref.file) || `${ref.id}.${source.ext}`;
}

function promptHintFor(assignment, ref, source) {
  const note = assignment.note ?? (typeof ref.note === 'string' ? ref.note : '');
  const fenced = fencedNote(note);

  if (assignment.slot === 'motion_reference') {
    const at = source.frame ? formatSeconds(source.frame.atSec) : null;
    const frameText = `first extracted frame (frame 0${at ? ` at ${at}s` : ''})`;
    return capText(
      [
        fenced,
        `Use the ${frameText} as the image reference for this plate.`,
        'LTX i2v takes no video file, so the motion reference only guides the prompt and that start frame.',
      ].filter(Boolean).join(' '),
      MAX_PROMPT_HINT_CHARS,
    );
  }

  if (!fenced) return '';
  return capText(fenced, MAX_PROMPT_HINT_CHARS);
}

export function toPackageInputs(assignment, ref) {
  const raw = objectInput(assignment, 'assignment');
  const reference = objectInput(ref, 'reference');
  const slot = slotValue(raw.slot);
  const refId = idValue(reference.id, 'refId');
  const kind = kindOf(reference);
  if (!kind) fail('INVALID_REFERENCE', 'refId', `reference ${refId} has no image or video kind`);

  const source = selectedSource(raw, reference, kind);
  if (!source.sha256) fail('INVALID_REFERENCE', 'sha256', `reference ${refId} needs a sha256 to become a package asset`);
  if (!source.bytes) fail('INVALID_REFERENCE', 'bytes', `reference ${refId} needs positive bytes to become a package asset`);

  const assetId = assetIdFor(reference, source);
  const packageAsset = {
    kind: 'image',
    origin: 'upload',
    status: 'ready',
    file: `assets/${assetId}.${source.ext}`,
    sha256: source.sha256,
    bytes: source.bytes,
    source: {
      provider: 'upload',
      id: provenanceId(reference, source),
      original_file: provenanceFile(reference, source),
    },
    license: { ...USER_UPLOAD_LICENSE },
    redistributable: false,
    notes: packageNotes(reference, source.frame, source.frameIndex),
  };

  let genInputs = {};
  if (slot === 'style_reference' || slot === 'subject_reference') genInputs = { reference: assetId };
  if (slot === 'start_frame') genInputs = { image: assetId };

  return {
    packageAsset,
    genInputs,
    promptHint: promptHintFor(raw, reference, source),
  };
}
