// AI2: kinetic headline phrasing.
//
// The visual concept is deliberately narrow: the existing copy stays the source
// of truth, while `motion.cue_phrases` groups its words into speech-sized
// beats. `motion.cue_seconds` (already the diagram contract) anchors those
// beats; when it is absent the beats spread deterministically through the
// scene. There is no wall clock and no per-frame accumulated state.

import { ease, staggerFrames } from '../motion/index.js';
import { clamp, normalizeCuePhrases, normalizeCueSeconds, recipeWindow } from './model.js';

/**
 * @typedef {{text:string,trailing:string,start:number,group:number,index:number}} KineticWord
 * @typedef {{phrase:string,start:number,end:number,words:number[]}} KineticGroup
 */

/**
 * Split copy into words with their trailing whitespace preserved. Punctuation
 * stays attached, so the rendered headline is character-identical.
 * @param {string} headline
 * @returns {Array<{text:string,trailing:string,start:number,end:number}>}
 */
export function kineticWords(headline) {
  const words = [];
  const pattern = /(\S+)(\s*)/g;
  let match;
  while ((match = pattern.exec(String(headline ?? ''))) !== null) {
    const start = match.index;
    words.push({ text: match[1], trailing: match[2], start, end: start + match[1].length });
  }
  return words;
}

/**
 * Match planner phrases to contiguous word ranges. Phrases not present in the
 * headline are ignored; any leftover words become their own beats. This keeps a
 * stale or translated cue list from deleting copy.
 * @param {string} headline
 * @param {string[]} phrases
 * @returns {Array<{phrase:string,words:number[]}>}
 */
export function phraseGroups(headline, phrases) {
  const words = kineticWords(headline);
  const text = String(headline ?? '').toLowerCase();
  /** @type {Array<{phrase:string,words:number[]}>} */
  const groups = [];
  const assigned = new Array(words.length).fill(false);
  let cursor = 0;
  for (const phrase of normalizeCuePhrases(phrases)) {
    const needle = phrase.toLowerCase();
    const found = text.indexOf(needle, cursor);
    if (found < 0) continue;
    const end = found + needle.length;
    const indexes = [];
    words.forEach((word, index) => {
      if (word.start >= found && word.end <= end) indexes.push(index);
    });
    if (indexes.length === 0) continue;
    groups.push({ phrase, words: indexes });
    for (const index of indexes) assigned[index] = true;
    cursor = end;
  }
  // Fill unmatched runs. A group of one or two words keeps the beat moving even
  // when the planner supplied no phrases at all.
  let run = [];
  const flush = () => {
    if (run.length === 0) return;
    const phrase = run.map(index => words[index].text).join(' ');
    groups.push({ phrase, words: [...run] });
    run = [];
  };
  words.forEach((_, index) => {
    if (assigned[index]) {
      flush();
      return;
    }
    run.push(index);
    if (run.length >= 2) flush();
  });
  flush();
  groups.sort((a, b) => a.words[0] - b.words[0]);
  return groups.map(group => ({ ...group, words: [...group.words].sort((a, b) => a - b) }));
}

/**
 * @param {{headline?:string,phrases?:string[],cues?:number[],fps?:number,sceneFrames?:number,seed?:number}} options
 * @returns {{words:KineticWord[],groups:KineticGroup[],start:number,end:number}}
 */
export function kineticPlan({ headline = '', phrases = [], cues = [], fps = 30, sceneFrames = 300, seed = 1 }) {
  const wordTokens = kineticWords(headline);
  const groups = phraseGroups(headline, phrases);
  const cueSeconds = normalizeCueSeconds(cues);
  const window = recipeWindow({ frame: 0, fps, sceneFrames, cues: cueSeconds, startFraction: 0.04, endFraction: 0.6, holdSeconds: 0.65 });
  const start = window.start;
  const end = window.end;
  const groupCount = Math.max(1, groups.length);
  const span = Math.max(1, end - start);
  const starts = groups.map((_, index) => {
    if (cueSeconds.length >= groupCount) return Math.round(clamp(cueSeconds[index], 0, Math.max(0, (sceneFrames - 2) / fps)) * fps);
    if (index === 0) return start;
    return Math.round(start + (span * 0.82 * index) / groupCount);
  });
  for (let index = 1; index < starts.length; index += 1) {
    if (starts[index] < starts[index - 1]) starts[index] = starts[index - 1];
  }
  const words = wordTokens.map((word, index) => {
    const groupIndex = groups.findIndex(group => group.words.includes(index));
    const safeGroup = groupIndex < 0 ? 0 : groupIndex;
    const within = groups[safeGroup]?.words.indexOf(index) ?? 0;
    const groupStart = starts[safeGroup] ?? start;
    return {
      text: word.text,
      trailing: word.trailing,
      start: Math.round(groupStart + staggerFrames(Math.max(0, within), 0.045, fps, 0.16)),
      group: safeGroup,
      index,
    };
  });
  return {
    words,
    groups: groups.map((group, index) => ({
      phrase: group.phrase,
      start: starts[index] ?? start,
      end: index + 1 < starts.length ? starts[index + 1] : end,
      words: group.words,
    })),
    start,
    end,
  };
}

/**
 * Per-word entrance + active-group emphasis at a frame.
 * @param {{word:KineticWord,frame:number,fps?:number,activeGroup?:number}} options
 * @returns {{opacity:number,translateYPercent:number,scale:number,active:boolean}}
 */
export function kineticWordState({ word, frame, fps = 30, activeGroup = -1 }) {
  const reveal = clamp((frame - word.start) / Math.max(1, Math.round(fps * 0.47)));
  const eased = ease('enter', reveal);
  return {
    opacity: reveal <= 0 ? 0 : clamp(reveal * 2.2),
    translateYPercent: (1 - eased) * 108,
    scale: 0.96 + eased * 0.04,
    active: activeGroup >= 0 && word.group === activeGroup,
  };
}

/**
 * Group whose start is the latest at or before the frame.
 * @param {KineticGroup[]} groups
 * @param {number} frame
 */
export function activeGroupAt(groups, frame) {
  let active = -1;
  groups.forEach((group, index) => {
    if (frame >= group.start) active = index;
  });
  return active;
}
