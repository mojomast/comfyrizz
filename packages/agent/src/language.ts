/**
 * L1: language variants of a package.
 *
 * A variant is a new package whose on-screen copy and narration are translated
 * and whose `voice.language` matches the target, so a re-voiced narration and a
 * fresh timeline compile retime every scene and caption. The translation itself
 * is injected (`translator`) so the server can call the agent LLM and tests can
 * use a deterministic fake — this module is pure and offline.
 */
export const SUPPORTED_LANGUAGES = ['en', 'fr'] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export const LANGUAGE_LABELS: Record<SupportedLanguage, string> = { en: 'English', fr: 'Français' };
/** BCP-47 tags for captions (`WebVTT`) and the TTS engine. */
export const LANGUAGE_TAGS: Record<SupportedLanguage, string> = { en: 'en-US', fr: 'fr-FR' };
/** Kokoro voice language codes (see packages/tts/py/synth.py). */
export const VOICE_LANGUAGES: Record<SupportedLanguage, string> = { en: 'en-us', fr: 'fr-fr' };

export interface TranslatableString {
  sceneId: string;
  /** `copy.headline`, `copy.items[2]` or `narration`. */
  path: string;
  text: string;
}

export interface SceneTranslation {
  copy?: Record<string, unknown>;
  narration?: string;
}

export interface LanguageVariantOptions {
  language: SupportedLanguage;
  /** LLM output keyed by scene id; missing scenes keep their source copy. */
  translations?: Record<string, SceneTranslation>;
  /** Translated package title; defaults to the source title. */
  title?: string;
  /** Translated brief key message, when the package carries a brief. */
  keyMessage?: string;
}

const COPY_TEXT_KEYS = ['kicker', 'headline', 'sub', 'body', 'cta', 'footnote', 'quote'] as const;
const COPY_LIST_KEYS = ['items'] as const;

/** Every string a translator should see: scene copy strings, list items and narration. */
export function translatableStrings(pkg: Record<string, any>): TranslatableString[] {
  const out: TranslatableString[] = [];
  for (const scene of pkg.scenes ?? []) {
    if (typeof scene?.narration === 'string' && scene.narration.trim()) {
      out.push({ sceneId: scene.id, path: 'narration', text: scene.narration });
    }
    const copy = scene?.copy;
    if (!copy || typeof copy !== 'object') continue;
    for (const key of COPY_TEXT_KEYS) {
      const value = copy[key];
      if (typeof value === 'string' && value.trim()) out.push({ sceneId: scene.id, path: `copy.${key}`, text: value });
    }
    for (const key of COPY_LIST_KEYS) {
      const value = copy[key];
      if (!Array.isArray(value)) continue;
      value.forEach((item, index) => {
        if (typeof item === 'string' && item.trim()) out.push({ sceneId: scene.id, path: `copy.${key}[${index}]`, text: item });
      });
    }
  }
  return out;
}

/** The package id of a language variant, still matching `^pkg_[A-Za-z0-9_-]{4,64}$`. */
export function variantPackageId(id: string, language: SupportedLanguage): string {
  const base = String(id).replace(new RegExp(`-${language}$`), '');
  return `${base}-${language}`;
}

/**
 * A deterministic translator for tests and the offline example: look each
 * source string up in a dictionary, otherwise return a marked fallback so a
 * missing entry is visible rather than silently English.
 */
export function dictionaryTranslator(dictionary: Record<string, string>, language: SupportedLanguage): (text: string) => string {
  return text => dictionary[text] ?? `[${language}] ${text}`;
}

/** Translate every string with `translator`, grouped by scene id for `applyLanguageVariant`. */
export function translateStrings(pkg: Record<string, any>, language: SupportedLanguage, translator: (text: string) => string): Record<string, SceneTranslation> {
  const translations: Record<string, SceneTranslation> = {};
  for (const { sceneId, path, text } of translatableStrings(pkg)) {
    const entry = (translations[sceneId] ??= {});
    if (path === 'narration') {
      entry.narration = translator(text);
      continue;
    }
    const copy = (entry.copy ??= {});
    const listMatch = /^copy\.([a-zA-Z_]+)\[(\d+)\]$/.exec(path);
    if (listMatch) {
      const [, key, index] = listMatch;
      const list = (copy[key] = Array.isArray(copy[key]) ? (copy[key] as unknown[]) : []);
      list[Number(index)] = translator(text);
    } else {
      copy[path.slice('copy.'.length)] = translator(text);
    }
  }
  return translations;
}

/** The LLM instruction for translating a package's copy; JSON in, JSON out. */
export function translationPrompt(strings: TranslatableString[], language: SupportedLanguage): string {
  const payload = strings.map(item => ({ scene: item.sceneId, path: item.path, text: item.text }));
  return [
    `Translate each "text" into ${LANGUAGE_LABELS[language]} (${LANGUAGE_TAGS[language]}).`,
    'Keep product names, URLs and numbers exact. Keep the JSON shape identical.',
    'Return only a JSON array of {"scene","path","text"} with the same length and order.',
    JSON.stringify(payload),
  ].join('\n');
}

/** Recursively merge translated copy over the source copy, leaving untouched keys intact. */
function mergeCopy(source: Record<string, unknown>, translated: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...source };
  for (const [key, value] of Object.entries(translated)) {
    if (key === 'items' && Array.isArray(value)) {
      const base = Array.isArray(source.items) ? (source.items as unknown[]) : [];
      merged.items = base.map((item, index) => (typeof value[index] === 'string' ? value[index] : item));
      continue;
    }
    if (typeof value === 'string' || (Array.isArray(value) && value.every(item => typeof item === 'string'))) merged[key] = value;
  }
  return merged;
}

/**
 * Build a language variant: translated copy + narration, `voice.language` set so
 * the re-voiced narration matches, and the variant id/title. Pure (structured
 * clone), so the source package is untouched.
 */
export function applyLanguageVariant(pkg: Record<string, any>, options: LanguageVariantOptions): Record<string, any> {
  const language = options.language;
  const variant = structuredClone(pkg) as Record<string, any>;
  variant.id = variantPackageId(pkg.id, language);
  variant.title = options.title ?? pkg.title;
  const translations = options.translations ?? {};

  const voice = { ...(variant.voice ?? {}) };
  const hasNarration = Object.values(translations).some(entry => typeof entry.narration === 'string' && entry.narration.trim());
  if (voice.enabled !== false || hasNarration) voice.enabled = true;
  if (hasNarration && (!voice.engine || voice.engine === 'none')) voice.engine = 'kokoro';
  voice.language = VOICE_LANGUAGES[language];
  variant.voice = voice;

  for (const scene of variant.scenes ?? []) {
    const translated = translations[scene.id];
    if (!translated) continue;
    if (translated.copy && typeof translated.copy === 'object') {
      scene.copy = mergeCopy(scene.copy ?? {}, translated.copy);
    }
    if (typeof translated.narration === 'string') scene.narration = translated.narration;
  }

  if (variant.brief && typeof variant.brief === 'object') {
    const brief = { ...variant.brief } as Record<string, any>;
    brief.audience = { ...(brief.audience ?? {}), language };
    brief.voice = { ...(brief.voice ?? {}), lang: language };
    if (options.keyMessage) brief.key_message = options.keyMessage;
    variant.brief = brief;
  }

  return variant;
}
