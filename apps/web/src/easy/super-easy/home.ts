// SE04: the presentational Super Easy home.
//
// The happy path is one prompt and one primary Generate. There is no level
// picker and no plan or shot editing here; those stay in the Easy studio
// behind the more-control link. Draft is chosen under the hood by the caller.

import { COPY } from './copy.ts';
import { COPY as EASY_COPY } from '../copy.ts';
import { superEasyBrandMarkup } from './brand.ts';
import { escapeHtml } from '../components.ts';
import { escapeToStudio } from './escape.ts';
import { renderProcedureToggle } from '../procedure/toggle.ts';
import type { SuperEasySetup } from './setup.ts';
import type { EasyIdea, LyricsStyle, SongTrim } from '../types.ts';
import { VIDEO_TYPE_LIST, videoTypeMetadata, type VideoType } from './video-types.ts';
import { renderSuperEasyContextAttachments } from './context-attachments.ts';
import { MIN_EASY_SECONDS, MAX_EASY_SECONDS, EASY_DURATION_PRESETS } from '../duration.ts';

export const SUPER_EASY_MIN_PROMPT_CHARS = 10;
const LENGTHS = EASY_DURATION_PRESETS;

/** One-click starting prompts, keyed by `data-super-easy-idea`. */
export const SUPER_EASY_IDEAS: Readonly<Record<string, string>> = COPY.ideas;

export interface SuperEasyHomeOptions {
  /** Initial prompt text; escaped before it reaches the page. */
  prompt?: string;
  /** Current video id, kept by the more-control escape. */
  packageId?: string | null;
  /** Current address, so unrelated query parameters survive the escape. */
  search?: string;
  /** Show the "Record this run" checkbox under Generate. */
  capture?: { armed: boolean };
  /** Saved setup preference; no API keys or tokens enter this view model. */
  setup?: SuperEasySetup;
  /** Shared Easy idea duration; 30 seconds remains the credit-safe default. */
  lengthS?: EasyIdea['lengthS'];
  aspect?: EasyIdea['aspect'];
  /** Null/undefined is Custom, preserving the original prompt-only flow. */
  videoType?: VideoType | null;
  /** Optional Music Video song range; null keeps the server-side default. */
  songTrim?: SongTrim | null;
  lyricsStyle?: LyricsStyle;
  /** Exact user-authored LRC, retained across view changes and validated only on Generate. */
  lyricsLrc?: string;
  deepSeekNoThinking?: boolean;
}

function ideaChips(): string {
  return Object.entries(SUPER_EASY_IDEAS)
    .map(([id, text]) => `<li><button type="button" class="super-easy-home-idea" data-super-easy-idea="${escapeHtml(id)}">${escapeHtml(text)}</button></li>`)
    .join('\n');
}

function lengthSegments(lengthS: EasyIdea['lengthS']): string {
  const options = LENGTHS.map((seconds) => {
    const checked = lengthS === seconds ? ' checked' : '';
    return `<label class="easy-segment"><input class="easy-segment-input" type="radio" name="super-easy-length" value="${seconds}" data-super-easy-length${checked} /><span class="easy-segment-title">${escapeHtml(EASY_COPY.idea.lengths[seconds])}</span></label>`;
  }).join('');
  const custom = !(LENGTHS as readonly number[]).includes(lengthS);
  return `<fieldset class="easy-segmented super-easy-home-length"><legend class="easy-segment-legend">${escapeHtml(EASY_COPY.idea.length)}</legend><div class="easy-segment-row">${options}</div><label for="super-easy-custom-length">Custom duration (seconds)</label> <input id="super-easy-custom-length" type="number" inputmode="numeric" min="${MIN_EASY_SECONDS}" max="${MAX_EASY_SECONDS}" step="1" value="${custom ? lengthS : ''}" placeholder="${MIN_EASY_SECONDS}–${MAX_EASY_SECONDS}" data-super-easy-custom-length aria-describedby="super-easy-length-help super-easy-length-error" /><p id="super-easy-length-help">Enter a whole number from ${MIN_EASY_SECONDS} to ${MAX_EASY_SECONDS}, or choose a preset. A duration in your prompt takes precedence. Non-preset durations are exact; presets are approximate.</p><p class="super-easy-home-error" id="super-easy-length-error" role="alert" data-super-easy-length-error hidden>Enter a whole number from ${MIN_EASY_SECONDS} to ${MAX_EASY_SECONDS} seconds.</p></fieldset>`;
}

export function renderSuperEasySongTrim(
  videoType: VideoType | null | undefined,
  songTrim: SongTrim | null | undefined,
  lengthS: EasyIdea['lengthS'],
): string {
  const musicVideo = String(videoType) === 'music-video';
  const start = songTrim && Number.isFinite(songTrim.startSeconds) ? String(songTrim.startSeconds) : '';
  const end = songTrim && Number.isFinite(songTrim.endSeconds) ? String(songTrim.endSeconds) : '';
  return `<fieldset class="super-easy-song-trim" data-super-easy-song-trim aria-describedby="super-easy-song-trim-help super-easy-song-trim-error"${musicVideo ? '' : ' hidden'}><legend>Song trim (optional)</legend><p id="super-easy-song-trim-help">Leave both fields blank to use the song from 0 seconds for the requested <span data-super-easy-song-trim-duration>${lengthS}</span>-second video duration. Otherwise enter a start and end in seconds; the end must be after the start.</p><div data-song-preview><p>Choose “Use as song master” on an attached song, then load it to listen and scrub in original song time.</p><button type="button" class="btn btn-secondary" data-song-preview-load>Load song preview</button><p data-song-preview-status role="status"></p><audio controls preload="metadata" data-song-preview-audio hidden></audio><div data-song-preview-actions hidden><button type="button" class="btn btn-secondary" data-song-preview-start>Set start at playhead</button> <button type="button" class="btn btn-secondary" data-song-preview-end>Set end at playhead</button> <button type="button" class="btn btn-secondary" data-song-preview-play>Play selected range</button></div></div><div class="super-easy-song-trim-fields"><label for="super-easy-song-start">Song start (seconds)<input id="super-easy-song-start" name="songStartSeconds" type="number" inputmode="decimal" min="0" step="any" value="${escapeHtml(start)}" placeholder="0" data-super-easy-song-start /></label><label for="super-easy-song-end">Song end (seconds)<input id="super-easy-song-end" name="songEndSeconds" type="number" inputmode="decimal" min="0" step="any" value="${escapeHtml(end)}" placeholder="${lengthS}" data-super-easy-song-end /></label></div><p class="super-easy-home-error" id="super-easy-song-trim-error" role="alert" data-super-easy-song-trim-error hidden>Enter both times with start at 0 or more and end after start, or leave both blank.</p></fieldset>`;
}

export function renderSuperEasyLyrics(
  videoType: VideoType | null | undefined,
  lyricsStyle: LyricsStyle | undefined,
  lyricsLrc: string | undefined,
): string {
  const musicVideo = String(videoType) === 'music-video';
  const style = lyricsStyle === 'caption' || lyricsStyle === 'reel' ? lyricsStyle : 'off';
  const raw = typeof lyricsLrc === 'string' ? lyricsLrc : '';
  const standardExample = '[00:12.00]First lyric line\n[00:15.50]Second lyric line';
  const enhancedExample = '[00:12.00]<00:12.00>First <00:12.45>lyric <00:13.10>line';
  return `<fieldset class="super-easy-lyrics" data-super-easy-lyrics${musicVideo ? '' : ' hidden'}><legend>Karaoke lyrics (optional)</legend><p id="super-easy-lyrics-timing-help">Timestamps are seconds in the original song; song trim applies later. Plain lyrics are never auto-timed. Lyrics add no narration or TTS.</p><label for="super-easy-lyrics-style">Lyrics style</label><select id="super-easy-lyrics-style" name="lyricsStyle" data-super-easy-lyrics-style><option value="off"${style === 'off' ? ' selected' : ''}>Off</option><option value="caption"${style === 'caption' ? ' selected' : ''}>Captions — bottom-safe</option><option value="reel"${style === 'reel' ? ' selected' : ''}>Reel — large overlay</option></select><label for="super-easy-lyrics-lrc">Paste LRC lyrics</label><textarea id="super-easy-lyrics-lrc" name="lyricsLrc" rows="6" spellcheck="false" autocapitalize="off" aria-describedby="super-easy-lyrics-timing-help super-easy-lyrics-examples super-easy-lyrics-error" placeholder="[00:12.00]First lyric line" data-super-easy-lyrics-lrc>${escapeHtml(raw)}</textarea><p class="super-easy-home-error super-easy-lyrics-error" id="super-easy-lyrics-error" role="alert" data-super-easy-lyrics-error hidden></p><details class="super-easy-lyrics-examples" id="super-easy-lyrics-examples"><summary>Standard and enhanced LRC examples</summary><p>Standard LRC times each line:</p><pre><code>${escapeHtml(standardExample)}</code></pre><p>Enhanced LRC also includes the word timestamps you supply:</p><pre><code>${escapeHtml(enhancedExample)}</code></pre></details></fieldset>`;
}

export function renderSuperEasyVideoTypes(selected: VideoType | null | undefined): string {
  const custom = !selected;
  const customCard = `<label class="super-easy-video-type${custom ? ' is-selected' : ''}"><input type="radio" name="super-easy-video-type" value="custom" data-super-easy-video-type${custom ? ' checked' : ''} /><span class="super-easy-video-type-name">Custom</span><span class="super-easy-video-type-description">Use your prompt as usual, with no preset direction.</span><span class="super-easy-video-type-cost">Current behavior</span></label>`;
  const presets = VIDEO_TYPE_LIST.map(type => {
    const checked = selected === type.id;
    const recommended = type.id === 'motion-explainer'
      ? '<span class="super-easy-video-type-badges"><span>Recommended</span><span>CPU-first</span></span>'
      : '';
    return `<label class="super-easy-video-type${checked ? ' is-selected' : ''}"><input type="radio" name="super-easy-video-type" value="${escapeHtml(type.id)}" data-super-easy-video-type${checked ? ' checked' : ''} /><span class="super-easy-video-type-name">${escapeHtml(type.label)}</span>${recommended}<span class="super-easy-video-type-description">${escapeHtml(type.description)}</span><span class="super-easy-video-type-cost">${escapeHtml(type.costLabel)}</span></label>`;
  }).join('\n');
  return `<details class="super-easy-disclosure super-easy-type-disclosure" data-super-easy-type-disclosure><summary><span class="super-easy-disclosure-icon" aria-hidden="true">▤</span><span>Video type</span><span class="super-easy-disclosure-value" data-super-easy-type-summary>${escapeHtml(videoTypeMetadata(selected)?.label ?? 'Custom')}</span></summary><fieldset class="super-easy-video-types" data-super-easy-video-types aria-describedby="super-easy-video-type-help"><legend>Video type</legend><p id="super-easy-video-type-help">Choose a starting point. This changes the prompt guidance, never the text you have written.</p><div class="super-easy-video-type-grid">${customCard}\n${presets}</div></fieldset></details>`;
}

/**
 * Render the Super Easy landing for a bare visit.
 *
 * The returned string is static markup: the prompt box, the one primary
 * Generate action, the optional example actions and the more-control link.
 * The empty-prompt message stays hidden until a too-short Generate.
 */
export function renderSuperEasyHome(options: SuperEasyHomeOptions = {}): string {
  const prompt = typeof options.prompt === 'string' ? options.prompt : '';
  const moreControlHref = escapeToStudio(options.search ?? '', options.packageId ?? null);
  const hosted = new URLSearchParams(options.search ?? '').get('demo') === '1';
  const colab = hosted || (options.setup?.compute === 'colab' && options.setup.confirmed);
  const selectedType = videoTypeMetadata(options.videoType);
  const hint = selectedType
    ? selectedType.inputHint
    : colab
      ? 'One sentence is enough. Your film is planned, generated, finished and ready to watch here.'
      : COPY.home.hint;
  const promptPlaceholder = selectedType?.promptPlaceholder ?? COPY.home.promptPlaceholder;
  const setupText = colab ? `Google Colab · up to ${options.setup?.spendCap} credits per video` : 'Connect your AI agent and Google Colab for generated films';
  const motionModel = options.setup?.motionModel ?? 'auto';
  const lengthS = options.lengthS ?? 30;
  return `<section class="super-easy-home" aria-labelledby="super-easy-title" data-super-easy-home>
${superEasyBrandMarkup()}
<div class="super-easy-hero">
<p class="super-easy-eyebrow"><span aria-hidden="true">✦</span> SUPER EASY MODE</p>
<h1 class="super-easy-home-title" id="super-easy-title">${escapeHtml(COPY.home.title)}</h1>
<p class="super-easy-home-subtitle">A little idea. A whole new world.<br />Describe it, shape the plan, and bring it to the screen.</p>
</div>
<form class="super-easy-home-form" data-super-easy-form novalidate>
<div class="super-easy-composer-heading"><span>Your next film starts here</span><span class="super-easy-step-label">01 / THE IDEA</span></div>
${renderSuperEasyVideoTypes(options.videoType)}
<label class="super-easy-home-label" for="super-easy-prompt">${escapeHtml(COPY.home.promptLabel)}</label>
<textarea class="super-easy-home-prompt" id="super-easy-prompt" name="prompt" rows="4" minlength="${SUPER_EASY_MIN_PROMPT_CHARS}" required placeholder="${escapeHtml(promptPlaceholder)}" aria-describedby="super-easy-prompt-hint">${escapeHtml(prompt)}</textarea>
<p class="super-easy-home-hint" id="super-easy-prompt-hint" data-super-easy-prompt-hint>${escapeHtml(hint)}</p>
<p class="super-easy-home-error" id="super-easy-prompt-error" role="alert" data-super-easy-prompt-error hidden>${escapeHtml(COPY.home.emptyPrompt)}</p>
<details class="super-easy-disclosure"><summary><span class="super-easy-disclosure-icon" aria-hidden="true">+</span><span>References &amp; inspiration</span><span class="super-easy-disclosure-value">Optional</span></summary>${renderSuperEasyContextAttachments()}</details>
${renderSuperEasySongTrim(options.videoType, options.songTrim, lengthS)}
${renderSuperEasyLyrics(options.videoType, options.lyricsStyle, options.lyricsLrc)}
<div class="super-easy-format-row">
${lengthSegments(lengthS)}
<fieldset data-super-easy-music-layout><legend>Video layout</legend><label for="super-easy-music-aspect">Output orientation</label><select id="super-easy-music-aspect" data-super-easy-music-aspect><option value="16:9"${(options.aspect ?? '16:9') === '16:9' ? ' selected' : ''}>Landscape (16:9)</option><option value="9:16"${options.aspect === '9:16' ? ' selected' : ''}>Vertical (9:16)</option><option value="1:1"${options.aspect === '1:1' ? ' selected' : ''}>Square (1:1)</option></select><p>Choose one layout for this video.</p></fieldset>
</div>
<details class="super-easy-disclosure super-easy-advanced"><summary><span class="super-easy-disclosure-icon" aria-hidden="true">☷</span><span>Fine-tune</span><span class="super-easy-disclosure-value">Model, font &amp; planning</span></summary>
<label class="super-easy-home-motion-model">Motion model<select data-super-easy-motion-model aria-label="Motion model"><option value="auto"${motionModel === 'auto' ? ' selected' : ''}>Auto — H3 acting + LTX camera</option><option value="h3"${motionModel === 'h3' ? ' selected' : ''}>MiniMax H3 — characters + native sound</option><option value="ltx"${motionModel === 'ltx' ? ' selected' : ''}>LTX-2.5 — cinematic motion plates</option><option value="klein"${motionModel === 'klein' ? ' selected' : ''}>Klein only — stills + code motion</option></select></label>
<fieldset><legend>Editable title font (optional)</legend><p>Upload a TrueType font you are authorized to use. It will be used for text in the video and included in the project.</p><label><input type="checkbox" data-super-easy-font-rights /> I have the rights to use this font in my video.</label><label>Font file (.ttf, max 5 MiB)<input type="file" accept=".ttf,font/ttf" data-super-easy-font-file /></label><button type="button" data-super-easy-font-remove>Remove supplied font</button><p role="status" data-super-easy-font-status></p></fieldset>
<label><input type="checkbox" data-super-easy-deepseek-no-thinking${options.deepSeekNoThinking ? ' checked' : ''} /> Disable thinking for DeepSeek Flash (OpenCode Go or direct)</label>
${options.capture ? renderProcedureToggle({ armed: options.capture.armed, id: 'super-easy-capture' }) : ''}
</details>
<p class="super-easy-home-hint">Planning uses your model provider and may make up to 12 additional SVG requests. Provider charges may apply.</p>
<div class="super-easy-home-actions">
<button type="submit" class="btn btn-primary super-easy-home-generate" data-super-easy-generate>${escapeHtml(COPY.home.generate)}</button>
<button type="button" class="btn btn-secondary super-easy-home-example" data-super-easy-example>${escapeHtml(COPY.home.tryExample)}</button>
</div>
</form>
${hosted ? '<div class="super-easy-home-setup"><span>DeepSeek V4.1 Flash · Google Colab · configured for you</span></div><p data-guest-credits role="status">Checking available invite credits…</p><p>Google Colab spending is approved up to your invite’s available credits. Credits are shared by everyone using this link. CPU work and agent edits remain available after those credits run out.</p>' : `<div class="super-easy-home-setup"><span>${escapeHtml(setupText)}</span><button type="button" class="btn btn-secondary btn-sm" data-super-easy-setup>${colab ? 'Change setup' : 'Set up AI & Google Colab'}</button></div>`}
<div class="super-easy-home-ideas">
<p class="super-easy-home-ideas-label" id="super-easy-ideas-label">${escapeHtml(COPY.home.ideasLabel)}</p>
<ul class="super-easy-home-idea-list" aria-labelledby="super-easy-ideas-label">
${ideaChips()}
</ul>
</div>
${hosted ? '' : `<p class="super-easy-home-more"><a class="super-easy-home-more-link" href="${escapeHtml(moreControlHref)}" data-super-easy-more-control>${escapeHtml(COPY.home.moreControl)}</a></p>`}
</section>`;
}
