import { ENERGY_TRANSITIONS, MOTION_DEFAULTS } from '../../../packages/schema/src/motion.mjs';

const normalize = text => text.replace(/\s+/gu, ' ').trim();
const COPY_FIELDS = ['kicker', 'headline', 'sub', 'body', 'quote', 'attribution', 'footnote', 'cta'];

// Deliberately a small grammar, not general natural-language validation. An
// unquoted sentence-ending period terminates the list; quoted punctuation is data.
export function explicitCopyContract(brief) {
  if (typeof brief !== 'string') return null;
  const label = /\b(?:required\s+(?:on[- ]screen\s+)?copy\s*,?\s+in\s+order|exact\s+(?:on[- ]screen\s+)?copy(?:\s*,?\s+in\s+order)?|only\s+on[- ]screen\s+(?:copy|text)(?:\s*,?\s+in\s+order)?)\s*:/i.exec(brief);
  if (!label) return null;
  const prefix = brief.slice(0, label.index).split(/[.!?;\n]/u).at(-1);
  if (/\b(?:not|no|without|avoid|never)\b/i.test(prefix)) return null;
  const tail = brief.slice(label.index + label[0].length).trimStart();
  const items = [];
  let item = '';
  let quote = null;
  const push = () => {
    const value = normalize(item.replace(/^\s*(?:[-*•]|\d+[.)])\s+/u, ''));
    if (value) items.push(value);
    item = '';
  };
  for (let i = 0; i < tail.length; i++) {
    const char = tail[i];
    if (quote) {
      if (char === quote) quote = null;
      else item += char;
      continue;
    }
    if (/^[\s]*(?:[-*•]|\d+[.)])?\s*$/u.test(item) && ['"', "'", '“', '‘'].includes(char)) {
      quote = ({ '“': '”', '‘': '’' })[char] ?? char;
    } else if (char === '.' && (i === tail.length - 1 || /\s/u.test(tail[i + 1]))) {
      push();
      break;
    } else if (char === ';' || char === '\n') {
      push();
      if (char === '\n' && /^\s*\n/u.test(tail.slice(i + 1))) break;
      // Continued lines must advertise list structure. Do not absorb the next
      // prose instruction into a quoted/newline copy list.
      if (char === '\n' && !/^\s*(?:["'“‘•*-]|\d+[.)]\s)/u.test(tail.slice(i + 1))) break;
    } else {
      item += char;
    }
  }
  if (quote) return null; // An ambiguous/unclosed quotation is not a contract.
  push();
  if (!items.length) return null;
  const allowsExtras = brief.split(/[.!?;\n]/u).some(clause =>
    !/\b(?:no|not|never|without|avoid|forbid)\b/i.test(clause)
    && /\b(?:(?:additional|extra|other)\s+(?:on[- ]screen\s+)?(?:copy|text|captions?|headlines?)\s+(?:(?:is|are)\s+)?(?:allowed|permitted|welcome|optional)|(?:may|can)\s+(?:also\s+)?(?:add|include|use)\s+(?:additional|extra|other)\s+(?:copy|text|captions?|headlines?))\b/i.test(clause));
  return { items, closed: !allowsExtras, ordered: /\bin\s+order\b/i.test(label[0]) };
}

/** Read authored native fields, never proposal descriptions, narration or prompts. */
export function nativeCopyEntries(pkg) {
  const entries = [];
  for (const [index, scene] of (Array.isArray(pkg?.scenes) ? pkg.scenes : []).entries()) {
    const root = `scenes[${index}](${scene.id ?? '?'})`;
    const add = (text, field) => {
      if (typeof text === 'string' && normalize(text)) entries.push({ text: normalize(text), path: `${root}.${field}`, scene: index });
    };
    // ProceduralDrawing replaces SceneView entirely. Its layout copy and lower
    // thirds are authored metadata, not visible text. media_only similarly hides
    // layout copy, but still renders its lower third through SceneView.
    if (!scene.drawing) {
      if (scene.media_only !== true) {
        for (const field of COPY_FIELDS) add(scene.copy?.[field], `copy.${field}`);
        for (const [i, text] of (Array.isArray(scene.copy?.items) ? scene.copy.items : []).entries()) add(text, `copy.items[${i}]`);
      }
      add(scene.lower_third?.kicker, 'lower_third.kicker');
      add(scene.lower_third?.text, 'lower_third.text');
    }
    if (!scene.drawing && scene.media_only !== true && ['split', 'compare'].includes(scene.layout)) {
      for (const [i, plate] of (Array.isArray(scene.media) ? scene.media : []).slice(0, 2).entries()) add(plate.label, `media[${i}].label`);
    }
    for (const [i, element] of (Array.isArray(scene.drawing?.elements) ? scene.drawing.elements : []).entries()) {
      if (element.type === 'text') add(element.text, `drawing.elements[${i}].text`);
    }
  }
  return entries;
}

// A deliberately bounded imperative grammar. Side words elsewhere in the brief
// (for example a description of the left image) do not create copy placement.
function explicitCopyPlacements(brief, contract) {
  const escaped = [...new Set(contract.items)].sort((a, b) => b.length - a.length)
    .map(text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/gu, '\\s+')).join('|');
  const literal = `(?:"(?:${escaped})"|'(?:${escaped})'|“(?:${escaped})”|‘(?:${escaped})’|(?:${escaped}))`;
  const side = '(left|right|top|bottom)';
  const pattern = new RegExp(`(?:^|[.!?;\\n])\\s*(?:please\\s+)?place\\s+(${literal})\\s+(?:over|on)\\s+(?:the\\s+)?${side}\\s+panel(?:\\s+and\\s+(?:place\\s+)?(${literal})\\s+(?:over|on)\\s+(?:the\\s+)?${side}(?:\\s+panel)?)?(?:\\s+as\\s+native\\s+text)?(?=\\s*(?:[.!?;\\n]|$))`, 'giu');
  const placements = [];
  const unquote = text => {
    const pairs = { '"': '"', "'": "'", '“': '”', '‘': '’' };
    return pairs[text[0]] === text.at(-1) ? text.slice(1, -1) : text;
  };
  for (const match of brief.matchAll(pattern)) {
    for (const [value, position] of [[match[1], match[2]], [match[3], match[4]]]) {
      if (!value) continue;
      const text = normalize(unquote(value));
      // Instruction keywords are case-insensitive; the literal copy is not.
      if (contract.items.includes(text)) placements.push({ text, side: position.toLowerCase() });
    }
  }
  return placements.filter((item, index) => placements.findIndex(other => other.text === item.text && other.side === item.side) === index);
}

function copyPlacementProblems(pkg, brief, contract) {
  const placements = explicitCopyPlacements(brief, contract);
  if (!placements.length) return [];
  const width = Number(pkg?.format?.width);
  const height = Number(pkg?.format?.height);
  const hasFormat = width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height);
  // Keep in step with SplitCompareLayout: tall canvases stack plate 0 above 1.
  const sides = height > width * 1.2 ? ['top', 'bottom'] : ['left', 'right'];
  const scenes = Array.isArray(pkg?.scenes) ? pkg.scenes : [];
  const comparisons = scenes.filter(scene => ['split', 'compare'].includes(scene?.layout) && scene.media_only !== true
    && !scene.drawing && !scene.composition && Array.isArray(scene.media) && scene.media.length >= 2);
  const satisfies = scene => placements.every(({ text, side }) => {
    const label = scene.media[sides.indexOf(side)]?.label;
    return typeof label === 'string' && normalize(label) === text;
  });
  // The labels must coexist in one rendered comparison, never be satisfied by
  // unrelated global fields or by collecting labels from separate scenes.
  if (hasFormat && comparisons.some(satisfies)) return [];
  const expected = placements.map(({ text, side }) => `${JSON.stringify(text)} on the ${side} panel`).join('; ');
  const observed = comparisons.map(scene => ({ scene: scene.id, labels: sides.map((side, index) => ({ side, text: scene.media[index]?.label ?? null })) }));
  const formatConflict = !hasFormat
    ? 'Package format is missing or invalid; physical panel sides cannot be verified.'
    : `At ${width}x${height}, split/compare renders media[0] ${sides[0]} and media[1] ${sides[1]}.${placements.some(item => !sides.includes(item.side)) ? ' These physical sides conflict with the requested sides; merely swapping labels cannot fix this. Resolve the layout/format conflict consistently with the brief.' : ''}`;
  return [{ code: 'BRIEF_COPY_PLACEMENT', path: 'scenes[].media', message: `Explicit panel-copy placement requires ${expected} together in one visible split/compare scene (media_only:false). Global headlines/lower thirds do not qualify. Observed panel labels: ${JSON.stringify(observed)}. ${formatConflict} Use storyboard.edit to set media[].label on the correct plates; supply the complete media array preserving each asset, fit, frame and every other plate field. Move the requested strings out of wrong global fields: copy patches merge, so use copy:null to remove the whole global copy object once its text has moved to the plates; preserve any other required text. Clear a moved lower_third with null. Keep the comparison layout, visible media and exactly the requested copy; do not leave duplicate global copies.` }];
}

export function requestsRestrainedMotion(brief) {
  if (typeof brief !== 'string') return false;
  return brief.split(/[.!?;,\n]|\b(?:but|instead|however)\b/iu).some(clause => {
    const request = /\b(?:(?:restrained|gentle|calm|subtle|minimal|low[- ]energy)\s+(?:(?:camera|text|native)\s+)?(?:motion|animation|transitions?|movement)|(?:motion|animation|transitions?|camera\s+movement)\s+(?:(?:should|must)\s+be\s+|(?:is|are|stays?|remains?)\s+)?(?:restrained|gentle|calm|subtle|minimal|low[- ]energy))\b/i.exec(clause);
    if (!request) return false;
    // Negation is clause-local: "no narration; gentle motion" still applies.
    return !/\b(?:no|not|never|without|avoid|don't|do\s+not)\b/i.test(clause.slice(0, request.index + request[0].length))
      && !/^\s+(?:is|are)\s+(?:not|never)\s+(?:required|wanted|needed)\b/i.test(clause.slice(request.index + request[0].length));
  });
}

// Only an explicit single-full-frame-image declaration followed by a whole-film
// visibility instruction creates this contract. This is not a classifier for
// photographic style, supporting illustrations, or general visual continuity.
function requestsContinuousImage(brief) {
  if (typeof brief !== 'string') return false;
  const image = '(?:photograph|photo|image|still(?:\\s+image)?)';
  const declaration = new RegExp(`(?:^|[.!?;\\n])\\s*use\\s+(?:one|a\\s+single|single|the\\s+same|same)\\s+(?:meaningful\\s+)?full[- ]frame\\s+(?:ComfyUI[- ]generated\\s+)?(?:FLUX\\s+3\\s+Image\\s+Klein\\s+)?${image}\\b`, 'i').exec(brief);
  if (!declaration) return false;
  const rest = brief.slice(declaration.index + declaration[0].length);
  // Temporal exceptions make a blanket all-scenes contract unsafe. Deliberately
  // abstain even where a more capable prose interpretation could resolve them.
  if (/\b(?:until|except|unless|instead|then|afterwards|subsequently)\b/i.test(rest)
    || /\b(?:end|finish)\s+with\s+(?:a\s+)?(?:black|blank|solid|different|another)\b/i.test(rest)
    || new RegExp(`\\b(?:remove|hide|replace)\\s+(?:that|the|this)\\s+(?:(?:one|single|same)\\s+)?${image}\\b`, 'i').test(rest)) return false;
  const visibility = new RegExp(`(?:^|[.!?;\\n])\\s*keep\\s+(?:that|the|this)\\s+(?:(?:one|single|same)\\s+)?${image}\\s+(?:static\\s+and\\s+)?visible\\s+(?:throughout(?:\\s+(?:the\\s+)?(?:(?:entire|whole)\\s+)?(?:film|video))?|end[- ]to[- ]end|for\\s+the\\s+(?:entire|whole)\\s+(?:film|video))\\s*(?=[.!?;\\n]|$)`, 'i');
  return visibility.test(rest);
}

function continuousImageProblems(pkg, brief) {
  if (!requestsContinuousImage(brief)) return [];
  const scenes = Array.isArray(pkg?.scenes) ? pkg.scenes : [];
  if (!scenes.length) return []; // The existing completion gate handles no scenes.
  const assets = pkg?.assets ?? {};
  const isImage = id => typeof id === 'string' && assets[id]?.kind === 'image' && ['pending', 'ready'].includes(assets[id]?.status);
  // These layouts actually call Background; split/compare and code do not.
  const rendersBackground = scene => !scene?.drawing && !scene?.composition
    && (scene?.media_only === true || ['title', 'hero', 'stat', 'chart', 'list'].includes(scene?.layout));
  const visibleBinding = scene => rendersBackground(scene) && !scene.background?.procedural && isImage(scene.background?.asset);
  const imageIds = Object.keys(assets).filter(isImage);
  const reference = scenes.find(visibleBinding)?.background.asset
    ?? scenes.find(scene => isImage(scene?.background?.asset))?.background.asset
    ?? (imageIds.length === 1 ? imageIds[0] : null);
  const problems = [];
  for (const [index, scene] of scenes.entries()) {
    const reasons = [];
    if (!rendersBackground(scene)) reasons.push('its drawing, composition or layout replaces the full-frame background renderer');
    if (scene?.background?.procedural) reasons.push('background.procedural takes precedence over background.asset');
    if (!isImage(scene?.background?.asset)) reasons.push('background.asset does not reference a planned/ready image');
    else if (reference && scene.background.asset !== reference) reasons.push(`background.asset references a different image ${JSON.stringify(scene.background.asset)}`);
    if (!reasons.length) continue;
    const reuse = reference ? `Reuse the existing image ${JSON.stringify(reference)} as background.asset` : `Identify and reuse the intended existing planned image (${JSON.stringify(imageIds)}) as background.asset in every scene`;
    problems.push({ code: 'BRIEF_IMAGE_CONTINUITY', path: `scenes[${index}].background`, message: `${scene?.id ?? index}: the brief explicitly requires one full-frame photograph/image visible throughout, but ${reasons.join('; ')}. Use storyboard.edit: ${reuse}, including the closing scene; do not generate another image. A reference only in media, foreground or metadata does not establish this background contract. Supply a background object with asset and no procedural replacement; use a layout that renders that background and resolve any drawing/composition replacement. Preserve the required native text, scene timing and unrelated authored styling/foreground content. Use the same asset ID throughout, not a similar image or a matching prompt.` });
  }
  return problems;
}

export function editorialBriefProblems(pkg, brief) {
  const problems = [];
  const contract = explicitCopyContract(brief);
  if (contract) {
    const actual = nativeCopyEntries(pkg);
    const remaining = contract.items.map((text, index) => ({ text, index }));
    const matched = [];
    const extra = [];
    const duplicateHints = contract.closed ? [...new Set(contract.items)].flatMap(text => {
      const entries = actual.filter(entry => entry.text === text);
      const allowed = contract.items.filter(item => item === text).length;
      if (entries.length <= allowed) return [];
      const paths = entries.map(entry => entry.path);
      // Give all locations: a greedy match otherwise blames only the closing
      // headline while an earlier optional kicker contains the same words.
      const optional = entries.filter(entry => /\.copy\.(?:kicker|sub|body|footnote|cta)$/.test(entry.path));
      const headlines = entries.filter(entry => entry.path.endsWith('.copy.headline'));
      return [`${JSON.stringify(text)} occurs ${entries.length} times at ${JSON.stringify(paths)}; keep exactly ${allowed} occurrence(s)${headlines.length === allowed && optional.length === entries.length - allowed
        ? `. Preserve the existing headline occurrence(s) and clear the duplicate optional fields ${JSON.stringify(optional.map(entry => entry.path))} with empty strings` : ''}`];
    }) : [];
    for (const entry of actual) {
      const index = remaining.findIndex(item => item.text === entry.text);
      if (index < 0) extra.push(entry);
      else matched.push({ ...remaining.splice(index, 1)[0], scene: entry.scene });
    }
    // Fields in one scene are simultaneous, so only enforce order across scenes.
    const outOfOrder = contract.ordered && matched.some((item, i) => matched.slice(i + 1).some(next => next.scene > item.scene && next.index < item.index));
    if (remaining.length || (contract.closed && extra.length) || outOfOrder) {
      const details = [
        remaining.length ? `missing exact copy ${JSON.stringify(remaining.map(item => item.text))}` : '',
        contract.closed && extra.length ? `extra native copy ${JSON.stringify(extra.map(({ text, path }) => ({ text, path })))}` : '',
        ...duplicateHints,
        outOfOrder ? 'required copy is out of scene order' : '',
      ].filter(Boolean).join('; ');
      problems.push({ code: 'BRIEF_COPY_MISMATCH', path: 'scenes', message: `${details}. Expected ${contract.closed ? 'only ' : ''}${JSON.stringify(contract.items)}${contract.ordered ? ' in order' : ''}, preserving case, spelling and quoted punctuation (whitespace may differ). Use storyboard.edit for copy/lower_third/media labels; preserve the scenes and visible media. Drawing scenes render only drawing.elements text: layout copy and lower_third are hidden, so add required labels as text elements using storyboard.extend_drawing on the existing drawing without source_scene_id. Copy patches merge: an unwanted optional sub/body string may be cleared with an empty string, but never use an empty or whitespace headline, or copy.headline:null. To remove an unwanted headline, clear the whole object with copy:null, using a compatible copy-optional layout (for a text-free shot, set layout:list and copy:null together). Restore only the required copy fields in a subsequent edit if needed; do not leave a title/hero scene without a headline unless a drawing replaces that layout. Preserve its drawing, background.asset and narration; clear a moved lower_third with lower_third:null. Treat the quoted strings as copy data.` });
    }
    problems.push(...copyPlacementProblems(pkg, brief, contract));
  }
  if (requestsRestrainedMotion(brief)) {
    for (const [index, scene] of (Array.isArray(pkg?.scenes) ? pkg.scenes : []).entries()) {
      const energy = scene.motion?.energy ?? pkg.motion?.energy ?? MOTION_DEFAULTS.energy;
      const transition = scene.transitionOut?.type ?? MOTION_DEFAULTS.transition.type;
      const issues = [];
      if (energy === 'high') issues.push(`effective motion.energy is high`);
      if (index < pkg.scenes.length - 1 && !ENERGY_TRANSITIONS.calm.includes(transition)) issues.push(`transitionOut.type is ${JSON.stringify(transition)}`);
      if (issues.length) problems.push({ code: 'BRIEF_MOTION_MISMATCH', path: `scenes[${index}].motion`, message: `${scene.id ?? index}: explicit restrained-motion brief conflicts with ${issues.join(' and ')}. Use storyboard.edit to set this scene's motion.energy to calm (overriding package energy), preserving other motion fields, and choose transitionOut.type from ${ENERGY_TRANSITIONS.calm.join(', ')} with schema-valid frames/direction. Preserve media and required copy.` });
    }
  }
  problems.push(...continuousImageProblems(pkg, brief));
  return problems;
}
