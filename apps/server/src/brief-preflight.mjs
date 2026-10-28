// PS03: deterministic brief preflight. A handful of briefs are unsatisfiable
// before any model call: two scene counts, a shot sum that overruns the total,
// narrated and wordless at once, LTX plus required dialogue, a FastH3 slot past
// its legal source, or a format the renderer cannot produce. Refuse those with
// a typed 400/422 instead of burning the tool loop and returning a 500.
//
// The checks are intentionally narrow. They only fire on explicit claims in the
// brief, so an ordinary solvable brief (and a sentence that says "not 8K") passes.

import { durationAcceptance } from './duration-policy.mjs';

// FastH3 sources come from the 17n+5 frame lattice at 24 fps. n=21 is the
// longest legal source (362 frames) the generation planner accepts.
export const FASTH3_MAX_SECONDS = 362 / 24;
export const BRIEF_UNSATISFIABLE = 'BRIEF_UNSATISFIABLE';
export const REFUSAL = 'REFUSAL';

const NUMBER_WORDS = Object.freeze({
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
});

const NUMBER_PATTERN = '(\\d+|one|two|three|four|five|six|seven|eight|nine|ten)';

function toNumber(value) {
  const text = String(value ?? '').toLowerCase();
  return NUMBER_WORDS[text] ?? Number(text);
}

function sentenceClauses(brief) {
  return brief.split(/[;!?\n]+|\.\s+/).map(clause => clause.trim()).filter(Boolean);
}

function isNegated(clause) {
  return /\b(?:no|not|never|avoid|without|don'?t|cannot|can't)\b/i.test(clause);
}

function sceneCountClaims(brief) {
  const claims = [];
  const pattern = new RegExp(`\\b(?:exactly|precisely)\\s+${NUMBER_PATTERN}\\s+(?:scenes?|shots?)\\b`, 'gi');
  for (const match of brief.matchAll(pattern)) {
    const count = toNumber(match[1]);
    if (Number.isFinite(count) && !claims.includes(count)) claims.push(count);
  }
  return claims;
}

function totalSeconds(brief) {
  const match = /(\d+(?:\.\d+)?)\s*[-\s]?seconds?\b/i.exec(brief);
  const seconds = match ? Number(match[1]) : NaN;
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

function shotCount(brief) {
  const match = /\b(?:in|into)\s+(\d+)\s+shots?\b/i.exec(brief);
  const count = match ? Number(match[1]) : NaN;
  return Number.isInteger(count) && count > 0 ? count : null;
}

function exactShotSeconds(brief) {
  const match = /(?:each|every)\s+(?:of\s+the\s+(?:\w+)\s+)?shots?\b[^.!?]{0,60}?\bexactly\s+(\d+(?:\.\d+)?)\s*seconds?/i.exec(brief);
  const seconds = match ? Number(match[1]) : NaN;
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

function reasonsForUnsupportedFormat(brief) {
  const reasons = [];
  for (const clause of sentenceClauses(brief)) {
    if (isNegated(clause)) continue;
    if (/\b8\s*k\b/i.test(clause)) reasons.push('8K resolution');
    if (/\b120\s*(?:fps\b|frames?\s*per\s*second\b)/i.test(clause)) reasons.push('120 fps');
    if (/\b2[.,]39\s*:\s*1\b/i.test(clause) || /\baspect\b[^.!?]{0,20}\b2[.,]39\b/i.test(clause)) reasons.push('2.39:1 aspect');
  }
  return [...new Set(reasons)];
}

function requiresDialogue(brief) {
  if (/\b(?:no|without|never|not)\s+(?:(?:native|spoken|synchroni[sz]ed|any)\s+){0,2}dialogue\b/i.test(brief)) return false;
  return /\b(?:requires?|required|needs?|must\s+(?:have|include|carry|use))\b[^.!?]{0,80}\b(?:spoken\s+|synchroni[sz]ed\s+)?dialogue\b/i.test(brief)
    || /\b(?:with|including|include)\s+(?:synchroni[sz]ed\s+)?(?:spoken\s+)?dialogue\b/i.test(brief);
}

function dialogueChoiceOffered(brief) {
  return /\b(?:may|can|allowed\s+to)\s+(?:switch|choose|use)\b[^.!?]{0,60}\b(?:h3|wordless)\b/i.test(brief)
    || /\beither\s+(?:h3|wordless)\b[^.!?]{0,60}\b(?:fine|acceptable|allowed|ok)\b/i.test(brief)
    || /(?:^|[.!?]\s+|,\s+)(?:choose|use|switch\s+to)\s+(?:h3|wordless)\b/i.test(brief);
}

function refusal(status, code, message, { details = [], reason, conflict, next_steps }) {
  return { status, code, message, details, reason, conflict, next_steps };
}

/**
 * Refuse an unsatisfiable brief before the planning tool loop starts.
 * Returns null when the brief can be planned.
 */
export function preflightBrief({ brief, motionModel } = {}) {
  if (typeof brief !== 'string' || brief.trim() === '') return null;
  const text = brief.trim();
  const model = typeof motionModel === 'string' ? motionModel.toLowerCase() : 'auto';

  const sceneCounts = sceneCountClaims(text);
  if (sceneCounts.length > 1) {
    const counts = sceneCounts.slice().sort((a, b) => a - b);
    return refusal(422, BRIEF_UNSATISFIABLE,
      `Brief contradicts itself: it requires ${counts.map(count => `exactly ${count} scenes`).join(' and ')} in the same brief. Choose one scene count before planning.`, {
        details: counts.map(count => `exactly ${count} scenes`),
        reason: 'conflicting scene counts',
        conflict: { field: 'sceneCount', values: counts },
        next_steps: ['Choose one scene count', 'Or ask the user which count to keep'],
      });
  }

  const seconds = totalSeconds(text);
  const shots = shotCount(text);
  const perShot = exactShotSeconds(text);
  if (seconds !== null && shots !== null && perShot !== null) {
    const planned = shots * perShot;
    const tolerance = durationAcceptance(seconds)?.toleranceSeconds ?? 0;
    if (Math.abs(planned - seconds) > tolerance) {
      return refusal(422, BRIEF_UNSATISFIABLE,
        `Timing contradiction: ${shots} shots x ${perShot} seconds = ${planned} seconds, which cannot fit the ${seconds}-second total. Change the total duration or the shot length.`, {
          details: [`${shots} shots x ${perShot} seconds = ${planned} seconds`, `brief total is ${seconds} seconds`],
          reason: 'shot lengths overrun the total duration',
          conflict: { field: 'durationSeconds', values: { total: seconds, shots, shotSeconds: perShot, planned } },
          next_steps: ['Change the total duration', 'Or change the per-shot length'],
        });
    }
  }

  const narrated = /\bnarrated\b/i.test(text) || /\bwith narration\b/i.test(text);
  const wordless = /\bwordless\b/i.test(text) || /\bno\s+(?:narration|voice[\s-]?over)\b/i.test(text);
  if (narrated && wordless) {
    return refusal(422, BRIEF_UNSATISFIABLE,
      'Brief contradicts itself: it is narrated with cue_phrases copied from narration, and also wordless with no narration or voice-over. Choose narration or wordless finishing before planning.', {
        details: ['narrated with cue_phrases copied from narration', 'wordless with no narration or voice-over'],
        reason: 'narration contradicts wordless',
        conflict: { field: 'narration', values: ['narrated', 'wordless'] },
        next_steps: ['Choose narrated', 'Or choose wordless'],
      });
  }

  const unsupported = reasonsForUnsupportedFormat(text);
  if (unsupported.length > 0) {
    return refusal(422, BRIEF_UNSATISFIABLE,
      `Unsupported format: ${unsupported.join(', ')} cannot be rendered. Use 1920x1080 at 30 fps and 16:9, or ask for a supported portrait size.`, {
        details: unsupported.map(reason => `unsupported format: ${reason}`),
        reason: 'the requested format is not supported',
        conflict: { field: 'format', values: unsupported },
        next_steps: ['Use 1920x1080 at 30 fps and 16:9', 'Or use 1080x1920 for a portrait film'],
      });
  }

  const ltx = model === 'ltx' || /\bmotion model\b[^.!?]{0,40}\bltx\b/i.test(text);
  if (ltx && requiresDialogue(text) && !dialogueChoiceOffered(text)) {
    return refusal(422, REFUSAL,
      'LTX cannot finish synchronized spoken dialogue, and the brief forbids switching to H3 or dropping the dialogue. Choose H3 for dialogue or wordless finishing with a sound plan before planning.', {
        details: ['LTX has no synchronized dialogue', 'choose H3 or wordless finishing'],
        reason: 'LTX and required dialogue cannot both hold',
        conflict: { field: 'motionModel', values: ['ltx', 'dialogue'] },
        next_steps: ['Switch the shot to H3', 'Or drop the dialogue and plan wordless finishing'],
      });
  }

  const h3 = model === 'h3' || /\b(?:must stay|one continuous)\b[^.!?]{0,40}\bh3\b/i.test(text);
  if (h3 && seconds !== null && seconds > FASTH3_MAX_SECONDS && (shots === 1 || /\bone continuous\b/i.test(text))) {
    return refusal(422, REFUSAL,
      `FastH3 cannot cover the ${seconds}-second shot: the editorial slot exceeds the legal FastH3 duration of ${FASTH3_MAX_SECONDS.toFixed(2)} seconds. Shorten the shot or split coverage into multiple shots.`, {
        details: [`${seconds}-second editorial slot`, `legal FastH3 duration is ${FASTH3_MAX_SECONDS.toFixed(2)} seconds`],
        reason: 'the FastH3 slot exceeds the legal source duration',
        conflict: { field: 'durationSeconds', values: { slot: seconds, max: FASTH3_MAX_SECONDS } },
        next_steps: ['Shorten the shot', 'Or split coverage into multiple shots'],
      });
  }

  return null;
}
