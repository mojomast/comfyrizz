// The web package typecheck has no @types/node; node:test imports are only
// for this file's runtime, so type checking is skipped here like the other
// Easy render tests.
// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { COPY } from './copy.ts';
import { renderSuperEasyHome } from './home.ts';
import { VIDEO_TYPE_LIST } from './video-types.ts';

const MIN_PROMPT_CHARS = 10;

function count(html: string, pattern: RegExp): number {
  return (html.match(pattern) || []).length;
}

function tagWith(html: string, attribute: string): string {
  const match = html.match(new RegExp(`<[a-z]+\\b[^>]*${attribute}[^>]*>`, 'u'));
  assert.ok(match, `missing ${attribute}`);
  return match[0];
}

test('Super Easy shows the Comfyrizz brand on the home screen', () => {
  const html = renderSuperEasyHome();
  assert.match(html, /class="super-easy-brand" aria-label="Comfyrizz"/u);
  assert.match(html, /class="super-easy-brand-name">Comfyrizz<\/span>/u);
  assert.match(html, /AI film studio/u);
});

test('Super Easy shows one primary Generate button and no level picker', () => {
  const html = renderSuperEasyHome();

  const buttons = html.match(/<button\b[^>]*>/g) ?? [];
  const primary = buttons.filter((button) => /class="[^"]*\bbtn-primary\b/u.test(button));
  assert.equal(primary.length, 1, 'exactly one primary button');
  assert.match(primary[0], /data-super-easy-generate/u);
  assert.match(html, /<button[^>]*data-super-easy-generate[^>]*>Generate<\/button>/u);
  assert.equal(COPY.home.generate, 'Generate');

  assert.match(html, /data-super-easy-home/u);
  assert.match(html, /data-super-easy-form/u);
  assert.equal(count(html, /data-iteration-choice=/g), 0);
  assert.equal(count(html, /data-easy-level=/g), 0);
  assert.equal(count(html, /iteration-card/g), 0);
  assert.equal(count(html, /<select\b/g), 3, 'motion model, lyric style and output orientation');
  assert.match(html, /data-super-easy-motion-model/u);
  assert.match(html, /data-super-easy-lyrics-style/u);
  assert.match(html, /id="super-easy-custom-length"[^>]*min="1"[^>]*max="120"[^>]*step="1"/u);
  assert.match(html, /data-super-easy-deepseek-no-thinking/);
  assert.match(html, /up to 12 additional SVG requests\. Provider charges may apply/);
  assert.ok(html.indexOf('Provider charges may apply') < html.indexOf('data-super-easy-generate'));
  assert.equal(count(html, /data-super-easy-video-type(?=[\s>])/g), VIDEO_TYPE_LIST.length + 1, 'Custom plus every shared preset');
  assert.equal(count(html, /data-super-easy-context-files/g), 1, 'one native file picker');
  assert.equal(count(html, /data-super-easy-context-url/g), 1, 'one explicit URL input');
});

test('hosted automatic setup retains the collapsed landing controls without duplicate model selectors', () => {
  const html = renderSuperEasyHome({ search: '?demo=1' });
  assert.match(html, /DeepSeek V4\.1 Flash · Google Colab · configured for you/);
  assert.match(html, /data-guest-credits/);
  assert.match(html, /CPU work and agent edits remain available after those credits run out/);
  assert.doesNotMatch(html, /data-super-easy-setup/);
  assert.equal(count(html, /data-super-easy-motion-model/g), 1);
  const disclosure = tagWith(html, 'data-super-easy-type-disclosure');
  assert.doesNotMatch(disclosure, /\bopen\b/);
  assert.equal(count(html, /data-super-easy-generate/g), 1);
});

test('120 seconds remains an exact custom duration rather than a new preset', () => {
  const html = renderSuperEasyHome({ lengthS: 120 });
  assert.match(html, /id="super-easy-custom-length"[^>]*value="120"[^>]*placeholder="1–120"/u);
  assert.doesNotMatch(html, /value="120" data-super-easy-length/u);
  assert.match(html, /Enter a whole number from 1 to 120 seconds/u);
  assert.match(html, /Non-preset durations are exact/u);
});

test('native video-type cards default to Custom and include every shared preset', () => {
  const html = renderSuperEasyHome();
  const group = html.match(/<fieldset[^>]*data-super-easy-video-types[^>]*>/u)?.[0];
  assert.ok(group);
  assert.match(html, /<legend>Video type<\/legend>/u);
  const cards = html.match(/<input\b[^>]*data-super-easy-video-type[^>]*>/gu) ?? [];
  assert.equal(cards.length, VIDEO_TYPE_LIST.length + 1);
  assert.equal(cards.filter(card => card.includes('type="radio"')).length, VIDEO_TYPE_LIST.length + 1);
  assert.equal(cards.filter(card => card.includes('name="super-easy-video-type"')).length, VIDEO_TYPE_LIST.length + 1);
  assert.equal(cards.filter(card => card.includes('checked')).length, 1);
  assert.ok(cards.find(card => card.includes('value="custom"'))?.includes('checked'));
  for (const type of VIDEO_TYPE_LIST) {
    assert.ok(cards.some(card => card.includes(`value="${type.id}"`)), type.id);
    assert.match(html, new RegExp(type.label, 'u'));
    assert.match(html, new RegExp(type.costLabel.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  }
  assert.match(html, /Recommended<\/span><span>CPU-first/u);
  assert.ok(html.indexOf('data-super-easy-video-types') < html.indexOf('id="super-easy-prompt"'));
});

test('a selected preset supplies guidance without becoming a second Generate action', () => {
  const type = VIDEO_TYPE_LIST.find(item => item.id === 'motion-explainer');
  const html = renderSuperEasyHome({ videoType: type.id, prompt: 'Keep my exact prompt' });
  const textarea = html.match(/<textarea\b[^>]*id="super-easy-prompt"[^>]*>/u)?.[0] ?? '';
  assert.match(textarea, new RegExp(`placeholder="${type.promptPlaceholder.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}"`, 'u'));
  assert.match(html, new RegExp(`data-super-easy-prompt-hint>${type.inputHint}</p>`, 'u'));
  assert.match(html, />Keep my exact prompt<\/textarea>/u);
  assert.ok((html.match(/<input\b[^>]*value="motion-explainer"[^>]*checked/u) ?? []).length === 1);
  assert.equal((html.match(/data-super-easy-generate/gu) ?? []).length, 1);
});

test('Music Video shows accessible optional song trim without replacing the prompt', () => {
  const html = renderSuperEasyHome({
    videoType: 'music-video',
    songTrim: { startSeconds: 2.5, endSeconds: 27 },
    lengthS: 60,
    prompt: 'Keep this exact song-video idea',
  });
  const group = html.match(/<fieldset[^>]*data-super-easy-song-trim[^>]*>/u)?.[0] ?? '';
  assert.ok(group);
  assert.doesNotMatch(group, /\bhidden\b/u);
  assert.match(html, /<legend>Song trim \(optional\)<\/legend>/u);
  assert.match(html, /from 0 seconds for the requested <span[^>]*>60<\/span>-second video duration/u);
  assert.match(html, /<label for="super-easy-song-start">Song start \(seconds\)/u);
  assert.match(html, /<label for="super-easy-song-end">Song end \(seconds\)/u);
  const start = tagWith(html, 'data-super-easy-song-start');
  const end = tagWith(html, 'data-super-easy-song-end');
  for (const input of [start, end]) {
    assert.match(input, /type="number"/u);
    assert.match(input, /min="0"/u);
  }
  assert.match(start, /value="2.5"/u);
  assert.match(end, /value="27"/u);
  assert.match(html, />Keep this exact song-video idea<\/textarea>/u);
  assert.match(renderSuperEasyHome().match(/<fieldset[^>]*data-super-easy-song-trim[^>]*>/u)?.[0] ?? '', /hidden/u);
});

test('Music Video alone shows accessible karaoke style, exact LRC paste, examples and timing help', () => {
  const raw = '[00:01.00]<00:01.00>Keep <00:01.50>this & <that>\n[00:03.00]Second line';
  const html = renderSuperEasyHome({
    videoType: 'music-video',
    lyricsStyle: 'reel',
    lyricsLrc: raw,
    prompt: 'Keep the creative prompt unchanged',
  });
  const group = html.match(/<fieldset[^>]*data-super-easy-lyrics[^>]*>/u)?.[0] ?? '';
  assert.ok(group);
  assert.doesNotMatch(group, /\bhidden\b/u);
  assert.match(html, /<label for="super-easy-lyrics-style">Lyrics style<\/label>/u);
  assert.match(html, /<option value="off">Off<\/option>/u);
  assert.match(html, /<option value="caption">Captions — bottom-safe<\/option>/u);
  assert.match(html, /<option value="reel" selected>Reel — large overlay<\/option>/u);
  assert.match(html, /<label for="super-easy-lyrics-lrc">Paste LRC lyrics<\/label>/u);
  const textarea = tagWith(html, 'data-super-easy-lyrics-lrc');
  assert.match(textarea, /aria-describedby="[^"]*super-easy-lyrics-timing-help[^"]*super-easy-lyrics-error/u);
  assert.match(html, /this &amp; &lt;that&gt;/u, 'the paste is escaped, not canonicalized');
  assert.match(html, /Standard LRC times each line/u);
  assert.match(html, /Enhanced LRC also includes the word timestamps/u);
  assert.match(html, /seconds in the original song; song trim applies later/u);
  assert.match(html, /Plain lyrics are never auto-timed/u);
  assert.match(html, /no narration or TTS/u);
  assert.match(html, /data-super-easy-lyrics-error hidden/u);
  assert.match(html, />Keep the creative prompt unchanged<\/textarea>/u);

  for (const videoType of [null, 'motion-explainer', 'product-walkthrough']) {
    const other = renderSuperEasyHome({ videoType, lyricsStyle: 'caption', lyricsLrc: raw });
    assert.match(other.match(/<fieldset[^>]*data-super-easy-lyrics[^>]*>/u)?.[0] ?? '', /\bhidden\b/u);
  }
});

test('attachment controls explain formats, planning-only use and explicit URL fetching accessibly', () => {
  const html = renderSuperEasyHome();
  assert.match(html, /<section[^>]*aria-labelledby="super-easy-context-title"[^>]*data-super-easy-attachments/u);
  assert.match(html, /<label for="super-easy-context-files">/u);
  assert.match(html, /type="file" multiple accept="[^"]*image\/png[^"]*video\/mp4[^"]*\.md[^"]*\.csv[^"]*"/u);
  assert.match(html, /20 MiB/u);
  assert.match(html, /200 MiB, up to 60 seconds/u);
  assert.match(html, /audio\/wav[^"]*audio\/mpeg/u);
  assert.match(html, /100 MiB, up to 300 seconds/u);
  assert.match(html, /necessary rights/u);
  assert.doesNotMatch(html.match(/type="file"[^>]*accept="([^"]*)"/u)?.[1] ?? '', /\.text/u);
  assert.match(html, /<label for="super-easy-context-url">/u);
  assert.match(html, /<button type="button"[^>]*data-super-easy-context-add-url>Add URL<\/button>/u);
  assert.match(html, /links written in your prompt are never fetched automatically/u);
  assert.match(html, /role="status" aria-live="polite"/u);
  assert.match(html, /Reference-only media is not output footage|reference-only media are planning context, not output footage/u);
});

test('Super Easy has an accessible duration group with the credit-safe 30 second default', () => {
  const html = renderSuperEasyHome();
  assert.match(html, /<fieldset[^>]*class="easy-segmented super-easy-home-length"/u);
  assert.match(html, /<legend[^>]*>Length<\/legend>/u);
  const lengths = html.match(/<input\b[^>]*data-super-easy-length[^>]*>/gu) ?? [];
  assert.equal(lengths.length, 4);
  for (const seconds of [15, 30, 60, 90]) {
    assert.ok(lengths.some((input) => input.includes(`type="radio"`) && input.includes(`value="${seconds}"`)));
  }
  assert.ok(lengths.find((input) => input.includes('value="30"'))?.includes('checked'));
  assert.equal(lengths.filter((input) => input.includes('checked')).length, 1);
  assert.equal(count(html, /class="easy-segment"/g), 4, 'each radio has a visible label');

  const selected = renderSuperEasyHome({ lengthS: 90 });
  assert.match(selected, /value="90" data-super-easy-length checked/u);
  assert.doesNotMatch(selected, /value="30" data-super-easy-length checked/u);
});

test('the prompt is a textarea with a real accessible label and the friendlier copy', () => {
  const html = renderSuperEasyHome();

  const textareas = html.match(/<textarea\b[^>]*>/g) ?? [];
  assert.equal(textareas.length, 2, 'one prompt box and the hidden Music Video LRC paste box');
  const textarea = textareas.find(tag => tag.includes('id="super-easy-prompt"'));
  assert.match(textarea, /id="super-easy-prompt"/u);
  assert.match(textarea, /name="prompt"/u);
  assert.match(textarea, /rows="4"/u);
  assert.match(textarea, /required/u);
  assert.match(textarea, new RegExp(`minlength="${MIN_PROMPT_CHARS}"`, 'u'));
  assert.match(textarea, new RegExp(`placeholder="${COPY.home.promptPlaceholder}"`, 'u'));

  const label = html.match(/<label\b[^>]*for="super-easy-prompt"[^>]*>([^<]*)<\/label>/u);
  assert.ok(label, 'the label points at the prompt');
  assert.equal(label[1], COPY.home.promptLabel);
  assert.equal(COPY.home.promptLabel, 'What is your video about?');

  const describedBy = textarea.match(/aria-describedby="([^"]+)"/u);
  assert.ok(describedBy, 'the prompt explains itself');
  assert.match(html, new RegExp(`id="${describedBy[1]}"`, 'u'));
  assert.match(html, new RegExp(`>${COPY.home.emptyPrompt}</p>`, 'u'));
});

test('the more-control link leaves for the Easy studio without looking like a submit button', () => {
  const html = renderSuperEasyHome();
  const link = html.match(/<a\b[^>]*data-super-easy-more-control[^>]*>([^<]*)<\/a>/u);
  assert.ok(link, 'the more-control link is present');
  assert.equal(link[1], COPY.home.moreControl);
  assert.equal(COPY.home.moreControl, 'I want more control');
  assert.match(link[0], /href="\?step=idea"/u);
  assert.equal(count(html, /data-super-easy-more-control/g), 1);
});

test('Try an example is an optional secondary action, never a second primary', () => {
  const html = renderSuperEasyHome();
  const example = tagWith(html, 'data-super-easy-example');
  assert.match(example, /type="button"/u);
  assert.match(example, /btn-secondary/u);
  assert.doesNotMatch(example, /btn-primary/u);
  assert.match(html, /<button[^>]*data-super-easy-example[^>]*>Try an example<\/button>/u);
  assert.equal(COPY.home.tryExample, 'Try an example');
});

test('the home has no plan or shot editing on the happy path', () => {
  const html = renderSuperEasyHome();
  assert.equal(count(html, /data-easy-plan/g), 0);
  assert.equal(count(html, /data-easy-shot/g), 0);
  assert.equal(count(html, /data-shot-/g), 0);
});

test('the section is labelled by its heading', () => {
  const html = renderSuperEasyHome();
  assert.match(html, /<section[^>]*aria-labelledby="super-easy-title"[^>]*data-super-easy-home/u);
  assert.match(html, /<h1[^>]*id="super-easy-title"[^>]*>Imagine it\. Make it\.<\/h1>/u);
  assert.equal(COPY.home.title, 'Imagine it. Make it.');
});

test('a prefilled prompt is escaped before it reaches the page', () => {
  const html = renderSuperEasyHome({ prompt: '<script>alert("hi")</script>' });
  assert.doesNotMatch(html, /<script>/u);
  assert.match(html, /&lt;script&gt;alert\(&quot;hi&quot;\)&lt;\/script&gt;/u);
  const primary = (html.match(/<button\b[^>]*>/g) ?? [])
    .filter((button) => /class="[^"]*\bbtn-primary\b/u.test(button));
  assert.equal(primary.length, 1, 'still one primary Generate');
});

test('home.css styles the Super Easy home without a second layout system', () => {
  const css = readFileSync(fileURLToPath(new URL('./home.css', import.meta.url)), 'utf8');
  for (const selector of [
    '.super-easy-home',
    '.super-easy-home-title',
    '.super-easy-home-prompt',
    '.super-easy-home-generate',
    '.super-easy-home-example',
    '.super-easy-home-more',
  ]) {
    assert.ok(css.includes(selector), `missing ${selector}`);
  }
});

test('the hint coaches instead of scolding, and the empty-prompt message waits for a short Generate', () => {
  const html = renderSuperEasyHome();
  assert.match(html, new RegExp(`id="super-easy-prompt-hint" data-super-easy-prompt-hint>${COPY.home.hint}</p>`, 'u'));
  assert.match(COPY.home.hint, /Google Colab/u);
  const error = tagWith(html, 'data-super-easy-prompt-error');
  assert.match(error, /role="alert"/u);
  assert.match(error, /\bhidden\b/u);
  assert.match(html, /<form[^>]*data-super-easy-form[^>]*novalidate/u, 'our message, not the browser tooltip');
});

test('idea chips are one-click starting prompts, never a second primary', () => {
  const html = renderSuperEasyHome();
  const chips = html.match(/<button\b[^>]*data-super-easy-idea="[a-z]+"[^>]*>[^<]+<\/button>/gu) ?? [];
  assert.equal(chips.length, Object.keys(COPY.ideas).length);
  assert.ok(chips.length >= 3);
  for (const chip of chips) {
    assert.match(chip, /type="button"/u);
    assert.doesNotMatch(chip, /btn-primary/u);
  }
  assert.match(html, new RegExp(`>${COPY.ideas.coffee}</button>`, 'u'));
});
