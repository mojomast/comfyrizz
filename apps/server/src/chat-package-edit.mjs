import { isDeepStrictEqual } from 'node:util';
import { validatePackage } from '../../../packages/schema/src/index.mjs';
import { LAYOUTS } from '../../../packages/schema/src/semantic.mjs';

const copyKeys = ['headline', 'sub', 'body', 'footnote', 'kicker'];
const textFields = keys => Object.fromEntries(keys.map(key => [key, { type: ['string', 'null'] }]));
export const PACKAGE_EDIT_TOOL = {
  name: 'project_edit_package',
  description: 'Stage focused edits to the authoritative saved package, even when there is no chat draft. Each call replaces the pending batch: include every intended pending edit in one call. Returns an exact before/after diff for review. Preserve all omitted fields, timing, assets and generation inputs. Null removes a named text field; removing the final required headline on a video-only shot also sets media_only=true, preserving its lower third. Remove foreground placements by exact existing asset IDs (never delete assets). Call project_build to save after review or when the user explicitly asks to apply/save these edits. Does not generate media.',
  parameters: {
    type: 'object', additionalProperties: false, required: ['packageId', 'expectedRevision', 'edits'],
    properties: {
      packageId: { type: 'string' }, expectedRevision: { type: 'integer', minimum: 0 },
      disableVoice: { type: 'boolean', enum: [true], description: 'Disable detached voiceover playback, retaining conditioning assets and generation inputs.' },
      edits: { type: 'array', maxItems: 100, items: {
        type: 'object', additionalProperties: false, required: ['sceneId'], properties: {
          sceneId: { type: 'string' }, backgroundMuted: { type: 'boolean' },
          removeNarration: { type: 'boolean', enum: [true] },
          removeForegroundAssets: { type: 'array', items: { type: 'string' }, minItems: 1, uniqueItems: true },
          copy: { type: 'object', additionalProperties: false, properties: textFields(copyKeys) },
          lowerThird: { type: 'object', additionalProperties: false, properties: textFields(['text', 'kicker']) },
        },
      } },
    },
  },
};

const invalid = message => Object.assign(new Error(message), { code: 'PACKAGE_EDIT_INVALID' });
function object(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw invalid('Use only the supported focused package edit fields.');
}

/** No model-authored package or JSON pointer is accepted. Work from the saved bytes. */
export function applyChatPackageEdit(pkg, input) {
  object(input, ['packageId', 'expectedRevision', 'disableVoice', 'edits']);
  if (input.packageId !== pkg.id || input.expectedRevision !== pkg.revision) {
    throw Object.assign(new Error('The saved package changed; reload and review the current package before editing.'), { status: 409, code: 'EDIT_PACKAGE_STALE' });
  }
  if (input.disableVoice !== undefined && input.disableVoice !== true) throw invalid('disableVoice must be true.');
  if (!Array.isArray(input.edits) || input.edits.length > pkg.scenes.length) throw invalid('Name existing scenes in edits.');
  const next = structuredClone(pkg);
  const diff = [];
  const change = (target, key, value, path) => {
    if (isDeepStrictEqual(target[key], value)) return;
    diff.push({ path, before: target[key] ?? null, after: value ?? null });
    if (value === undefined) delete target[key];
    else target[key] = structuredClone(value);
  };
  const seen = new Set();
  for (const edit of input.edits) {
    object(edit, ['sceneId', 'backgroundMuted', 'removeNarration', 'removeForegroundAssets', 'copy', 'lowerThird']);
    const scene = next.scenes.find(scene => scene.id === edit.sceneId);
    if (!scene || seen.has(edit.sceneId)) throw invalid('Each edit must name a unique existing scene.');
    seen.add(edit.sceneId);
    if (scene.locked) throw invalid(`Scene ${scene.id} is locked.`);
    const path = `scenes.${scene.id}`;
    if (edit.backgroundMuted !== undefined) {
      if (typeof edit.backgroundMuted !== 'boolean' || !scene.background?.asset || next.assets[scene.background.asset]?.kind !== 'video') throw invalid(`Scene ${scene.id} has no video background to mute/unmute.`);
      change(scene.background, 'muted', edit.backgroundMuted, `${path}.background.muted`);
    }
    if (edit.removeNarration !== undefined) {
      if (edit.removeNarration !== true) throw invalid('removeNarration must be true.');
      for (const key of ['narration', 'narration_asset', 'narration_duration_frames', 'narration_spoken', 'spoken_text']) change(scene, key, undefined, `${path}.${key}`);
    }
    if (edit.removeForegroundAssets !== undefined) {
      const ids = edit.removeForegroundAssets;
      if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string' || !scene.foreground?.some(item => item.asset === id))) throw invalid('Remove only exact existing foreground asset placements.');
      change(scene, 'foreground', scene.foreground.filter(item => !ids.includes(item.asset)), `${path}.foreground`);
    }
    for (const [field, keys, targetKey] of [['copy', copyKeys, 'copy'], ['lowerThird', ['text', 'kicker'], 'lower_third']]) {
      if (edit[field] === undefined) continue;
      object(edit[field], keys);
      if (scene.drawing) throw invalid(`Scene ${scene.id} renders a drawing; use the drawing editor for visible text.`);
      if (field === 'copy' && scene.media_only && Object.values(edit.copy).some(value => typeof value === 'string' && value.trim())) throw invalid(`Scene ${scene.id} skips layout copy; use the layout editor to make new text visible.`);
      const text = scene[targetKey] ?? {};
      for (const [key, value] of Object.entries(edit[field])) {
        if (value !== null && (typeof value !== 'string' || value.length > 4000)) throw invalid('Text edits must be strings or null.');
        change(text, key, value === null ? undefined : value, `${path}.${targetKey}.${key}`);
      }
      if (scene[targetKey] || Object.keys(text).length) scene[targetKey] = text;
    }
    // Removing the final layout text from a video shot means showing its
    // media, while retaining an independently rendered lower third. Do not
    // invent a replacement headline or change its layout/timing to pass schema.
    if (edit.copy?.headline === null && LAYOUTS[scene.layout]?.requiresHeadline) {
      const remaining = Object.values(scene.copy ?? {}).some(value => Array.isArray(value) ? value.length > 0 : typeof value === 'string' && value.trim());
      if (remaining || !scene.background?.asset || next.assets[scene.background.asset]?.kind !== 'video') throw invalid('Removing a required headline needs a video-only shot with no remaining layout copy.');
      change(scene, 'media_only', true, `${path}.media_only`);
    }
  }
  if (input.disableVoice) {
    // A global playback change affects every shot, including locked ones.
    if (next.scenes.some(scene => scene.locked)) throw invalid('Voice playback cannot change while a scene is locked.');
    next.voice ??= {};
    change(next.voice, 'enabled', false, 'voice.enabled');
    change(next.voice, 'engine', 'none', 'voice.engine');
  }
  if (!diff.length) throw invalid('No package fields changed.');
  const validation = validatePackage(next);
  if (!validation.valid) throw invalid(`Invalid package edit: ${validation.errors.map(e => `${e.path}: ${e.message}`).join('; ')}`);
  return { package: next, diff };
}
