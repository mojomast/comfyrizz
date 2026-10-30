export const EDIT_PLACEHOLDER = '<edit>';

const NEGATIVE_START = /^(?:no|not|never|don'?t|do not|avoid|without|remove|removing|delete|eliminate|stop|prevent)\b/i;
const ANATOMY_TERMS = /\b(hands?|fingers?|thumbs?|knuckles?|nails?|wrists?|palms?|feet|foot|toes?)\b/i;
const WARDROBE_TERMS = /\b(wardrobe|outfit|costume|clothes|clothing|coat|jacket|dress|shirt|blouse|sweater|trousers|pants|skirt|hat|cap|gloves?|boots?|shoes?|scarf|collar|sleeves?|buttons?|belt)\b/i;
const LOCALIZED_ANATOMY_CATEGORIES = new Set(['counting', 'appearance', 'composition', 'detail', 'small_detail']);
const LOCALIZED_PROMPT_CATEGORIES = new Set(['appearance', 'wardrobe']);
const DIMENSION_PRIORITY = Object.freeze({ text_artifact: 0, wardrobe: 1, anatomy: 2 });

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const textOf = (value) => (typeof value === 'string' ? value.trim() : '');

export function localizedEditDimension(check) {
  if (!isObject(check) || check.pass !== false || check.severity !== 'hard') return null;
  if (check.dimension === 'text_artifact') return 'text_artifact';
  const category = textOf(check.category).toLowerCase();
  const evidence = textOf(check.evidence);
  if (check.dimension === 'anatomy' && (LOCALIZED_ANATOMY_CATEGORIES.has(category) || ANATOMY_TERMS.test(evidence))) return 'anatomy';
  if (check.dimension === 'prompt' && (LOCALIZED_PROMPT_CATEGORIES.has(category) || WARDROBE_TERMS.test(evidence))) return 'wardrobe';
  return null;
}

export function planEdit(verdict) {
  const checks = Array.isArray(verdict?.checks) ? verdict.checks : [];
  const failed = checks.filter((check) => isObject(check) && check.pass === false);
  if (failed.length === 0) return null;
  const localized = [];
  for (const check of failed) {
    const dimension = localizedEditDimension(check);
    if (!dimension) return null;
    localized.push({ check, dimension });
  }
  if (!localized.some(({ check }) => check.severity === 'hard')) return null;
  const dimensions = [...new Set(localized.map(({ dimension }) => dimension))];
  dimensions.sort((a, b) => DIMENSION_PRIORITY[a] - DIMENSION_PRIORITY[b]);
  return {
    dimension: dimensions[0],
    dimensions,
    checks: localized.map(({ check }) => check),
  };
}

function positiveHint(hints, pattern) {
  const list = Array.isArray(hints) ? hints : [];
  for (const hint of list) {
    const text = textOf(hint);
    if (!text || NEGATIVE_START.test(text)) continue;
    if (pattern && !pattern.test(text)) continue;
    return text;
  }
  return '';
}

function sideOf(evidence) {
  if (/\bleft\b/i.test(evidence)) return 'left';
  if (/\bright\b/i.test(evidence)) return 'right';
  return '';
}

function anatomyInstruction(check) {
  const evidence = textOf(check?.evidence);
  const side = sideOf(evidence);
  if (/\b(?:feet|foot|toes?)\b/i.test(evidence)) {
    return `${side ? `the ${side} foot` : 'each foot'} has five toes`;
  }
  return `${side ? `the ${side} hand` : 'each hand'} has five fingers`;
}

function matchesCharacter(character, evidence) {
  const needles = [textOf(character.characterId), textOf(character.name)].filter(Boolean);
  return needles.some((needle) => {
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escaped}\\b`, 'i').test(evidence);
  });
}

function wardrobeInstruction(characters, evidence) {
  const cast = (Array.isArray(characters) ? characters : [])
    .filter((character) => isObject(character) && textOf(character.wardrobeState));
  const target = cast.find((character) => matchesCharacter(character, evidence)) ?? cast[0];
  return target ? `the wardrobe is ${textOf(target.wardrobeState)}` : 'the wardrobe matches the character bible exactly';
}

export function buildEditInstruction({ verdict, characters } = {}) {
  const plan = planEdit(verdict);
  if (!plan) return '';
  const hints = Array.isArray(verdict?.fixHints) ? verdict.fixHints : [];
  const check = plan.checks.find((item) => localizedEditDimension(item) === plan.dimension) ?? plan.checks[0];
  if (plan.dimension === 'text_artifact') {
    return positiveHint(hints) || 'the on-screen text is sharp, evenly spaced and cleanly readable';
  }
  if (plan.dimension === 'anatomy') {
    return positiveHint(hints, ANATOMY_TERMS) || anatomyInstruction(check);
  }
  return wardrobeInstruction(characters, textOf(check?.evidence));
}

export function fillEditDecision(decision, { editInstruction } = {}) {
  if (!isObject(decision) || decision.editInstruction !== EDIT_PLACEHOLDER) return decision;
  const text = textOf(editInstruction);
  if (!text) return decision;
  return { ...decision, editInstruction: text };
}
