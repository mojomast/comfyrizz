// L1: language + aspect variants of one package, and the manifest an export
// bundle writes for them. Pure: it builds new package objects and never renders.
// Fakes only — a caller injects `translations` (from the agent LLM) or leaves
// them out for an untranslated/English baseline.
import { applyLanguageVariant, cutdownPackage } from '../../../packages/agent/dist/src/index.js';
import { ASPECTS, relayoutPackage } from '../../renderer/src/layout-model.js';

export const VARIANT_ASPECTS = ASPECTS;
export const ASPECT_SLUGS = { '16:9': '16x9', '9:16': '9x16', '1:1': '1x1' };
/** X1 duration axis, in seconds, beside language and aspect. */
export const CUTDOWN_SECONDS = [6, 15, 30];

/** A filesystem- and id-safe slug for a language/aspect/duration tuple, e.g. `fr-9x16-15s`. */
export function variantSlug({ language = 'en', aspect = '16:9', duration = null } = {}) {
  const base = `${language}-${ASPECT_SLUGS[aspect] ?? '16x9'}`;
  if (duration == null) return base;
  return `${base}-${Number(duration)}s`;
}

/** The variant package id, still matching the schema `^pkg_[A-Za-z0-9_-]{4,64}$`. */
export function variantPackageId(baseId, { language = 'en', aspect = '16:9', duration = null } = {}) {
  if (language === 'en' && aspect === '16:9' && duration == null) return baseId;
  return `${baseId}-${variantSlug({ language, aspect, duration })}`;
}

/**
 * Build one package per language/aspect combination. The English 16:9 entry is
 * the base package (same id, no transform). A non-English variant gets
 * `narration: {}` so the exporter re-estimates captions from the translated
 * `scene.narration` instead of reusing the base language's measured cues.
 *
 * @param {object} pkg
 * @param {{languages?: string[], aspects?: string[], durations?: (number|null)[], translations?: Record<string, Record<string, object>>, voice?: Function}} [options]
 * `durations` is the X1 axis (6, 15, 30). Omit it and the language/aspect pairs are unchanged.
 * A cutdown re-voices through `voice` (the CPU stub when omitted) and passes `narration: {}`
 * so captions follow the rewritten lines instead of a previous language's measured cues.
 * @returns {{id:string, baseId:string, slug:string, language:string, aspect:string, durationSeconds:number|null, isBase:boolean, narration?:object, presenter?:object, voiced?:object[], package:object}[]}
 */
export function buildVariants(pkg, { languages = ['en'], aspects = ['16:9'], durations = [null], translations = {}, voice } = {}) {
  const languageList = [...new Set(languages)];
  const aspectList = [...new Set(aspects)];
  const durationList = durations.length ? [...new Set(durations)] : [null];
  const out = [];
  for (const language of languageList) {
    for (const aspect of aspectList) {
      for (const duration of durationList) {
        if (duration != null && !CUTDOWN_SECONDS.includes(duration)) {
          throw new Error(`duration must be one of ${CUTDOWN_SECONDS.join(', ')} seconds`);
        }
        const slug = variantSlug({ language, aspect, duration });
        const isBase = language === 'en' && aspect === '16:9' && duration == null;
        let variant = pkg;
        let narration;
        let presenter;
        let voiced;
        if (language !== 'en') {
          variant = applyLanguageVariant(variant, { language, translations: translations[language] ?? {} });
          narration = {};
        }
        if (aspect !== '16:9') variant = relayoutPackage(variant, aspect);
        if (duration != null) {
          const cut = cutdownPackage(variant, duration, voice ? { voice } : {});
          variant = cut.package;
          narration = cut.narration;
          presenter = cut.presenter;
          voiced = cut.voiced;
        }
        variant = { ...variant, id: variantPackageId(pkg.id, { language, aspect, duration }) };
        out.push({
          id: variant.id,
          baseId: pkg.id,
          slug,
          language,
          aspect,
          durationSeconds: duration,
          isBase,
          ...(narration !== undefined ? { narration } : {}),
          ...(presenter ? { presenter } : {}),
          ...(voiced ? { voiced } : {}),
          package: variant,
        });
      }
    }
  }
  return out;
}
