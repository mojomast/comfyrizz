import type { TimelineCaption } from './timeline.js';

/** Presentation only: retain measured word positions and never retime speech.
 * Unaligned/edited wording is left intact rather than fabricating alignment.
 */
export function phraseCaptions(cues: TimelineCaption[], fps: number, minSeconds = 0.8): TimelineCaption[] {
  if (!Number.isFinite(fps) || fps <= 0) throw new TypeError('Positive caption fps required');
  return cues.flatMap(cue => {
    const measured = cue.words;
    const display = cue.text.trim().split(/\s+/);
    const token = (text: string) => text.normalize('NFKC').toLowerCase().replace(/’/g, "'").replace(/[^\p{L}\p{N}']/gu, '');
    if (!measured?.length || measured.length !== display.length || measured.some((w, i) => !token(w.text) || token(w.text) !== token(display[i]))) return [cue];
    // Punctuation/case may come from the approved display text; semantic edits
    // still require new alignment. Never alter the measured time boundaries.
    const words = measured.map((w, i) => ({ ...w, text: display[i] }));
    if (words.some((w, i) => !Number.isFinite(w.from) || !Number.isFinite(w.to) || w.from < cue.from || w.to > cue.to || w.to <= w.from || (i > 0 && w.from < words[i - 1].to))) return [cue];
    const groups: typeof words[] = [];
    let start = 0;
    words.forEach((word, i) => {
      if (/[.!?]["'”’)]*$/.test(word.text) || i === words.length - 1) {
        groups.push(words.slice(start, i + 1));
        start = i + 1;
      }
    });
    // Merge a short sentence with a neighbor; do not create accidental word-pop.
    for (let i = 0; i < groups.length && groups.length > 1;) {
      const from = i === 0 ? cue.from : groups[i][0].from;
      const to = i + 1 < groups.length ? groups[i + 1][0].from : cue.to;
      if ((to - from) / fps >= minSeconds) { i++; continue; }
      if (i === 0) groups.splice(0, 2, [...groups[0], ...groups[1]]);
      else { groups.splice(i - 1, 2, [...groups[i - 1], ...groups[i]]); i--; }
    }
    return groups.map((group, i) => ({ ...cue, text: group.map(w => w.text).join(' '),
      from: i === 0 ? cue.from : group[0].from,
      to: i + 1 < groups.length ? groups[i + 1][0].from : cue.to,
      words: group.map(w => ({ ...w })),
    }));
  });
}
