// L1: language + aspect variants of one package, and the manifest an export
// bundle writes for them. Pure: it builds new package objects and never renders.
// Fakes only — a caller injects `translations` (from the agent LLM) or leaves
// them out for an untranslated/English baseline.
import { applyLanguageVariant } from '../../../packages/agent/dist/src/index.js';
import { ASPECTS, relayoutPackage } from '../../renderer/src/layout-model.js';

export const VARIANT_ASPECTS = ASPECTS;
export const ASPECT_SLUGS = { '16:9': '16x9', '9:16': '9x16', '1:1': '1x1' };

/** A filesystem- and id-safe slug for a language/aspect pair, e.g. `fr-9x16`. */
export function variantSlug({ language = 'en', aspect = '16:9' } = {}) {
  return `${language}-${ASPECT_SLUGS[aspect] ?? '16x9'}`;
}

/** The variant package id, still matching the schema `^pkg_[A-Za-z0-9_-]{4,64}$`. */
export function variantPackageId(baseId, { language = 'en', aspect = '16:9' } = {}) {
  if (language === 'en' && aspect === '16:9') return baseId;
  return `${baseId}-${variantSlug({ language, aspect })}`;
}

/**
 * Build one package per language/aspect combination. The English 16:9 entry is
 * the base package (same id, no transform). A non-English variant gets
 * `narration: {}` so the exporter re-estimates captions from the translated
 * `scene.narration` instead of reusing the base language's measured cues.
 *
 * @param {object} pkg
 * @param {{languages?: string[], aspects?: string[], translations?: Record<string, Record<string, object>>}} [options]
 * @returns {{id:string, baseId:string, slug:string, language:string, aspect:string, isBase:boolean, narration?:object, package:object}[]}
 */
export function buildVariants(pkg, { languages = ['en'], aspects = ['16:9'], translations = {} } = {}) {
  const languageList = [...new Set(languages)];
  const aspectList = [...new Set(aspects)];
  const out = [];
  for (const language of languageList) {
    for (const aspect of aspectList) {
      const slug = variantSlug({ language, aspect });
      const isBase = language === 'en' && aspect === '16:9';
      let variant = pkg;
      if (language !== 'en') {
        variant = applyLanguageVariant(variant, { language, translations: translations[language] ?? {} });
      }
      if (aspect !== '16:9') variant = relayoutPackage(variant, aspect);
      variant = { ...variant, id: variantPackageId(pkg.id, { language, aspect }) };
      out.push({
        id: variant.id,
        baseId: pkg.id,
        slug,
        language,
        aspect,
        isBase,
        ...(language === 'en' ? {} : { narration: {} }),
        package: variant,
      });
    }
  }
  return out;
}
