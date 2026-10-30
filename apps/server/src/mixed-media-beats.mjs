import { sceneShotPlates } from './scene-shot-plates.mjs';

const counts = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const unquote = value => value.trim().replace(/^["“']|["”']$/g, '');

/** Deliberately bounded author grammar: ordered, numbered Beat N paragraphs.
 * Neither asset notes nor a model's scene ID can grant a motion exemption. */
export function orderedBeatContract(brief) {
  if (typeof brief !== 'string') return null;
  const count = /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+ordered\s+beats\b/i.exec(brief)?.[1];
  const total = counts[count?.toLowerCase()] ?? Number(count);
  const matches = [...brief.matchAll(/(?:^|\n)\s*Beat\s+(\d+)\s*:\s*([^\n]+)/gi)];
  if (!(total >= 2 && total <= 20) || matches.length !== total || matches.some((match, i) => Number(match[1]) !== i + 1)) return null;
  const beats = matches.map((match, index) => {
    const clause = match[2];
    // Positive, explicit still-photo comparison instruction, not references for
    // motion generation, negated stills, or inferred intent from a subject noun.
    const declaration = /^A\s+native\s+two-panel\s+[^.!?\n]{0,80}?comparison\s+using\s+two\s+original\s+ComfyUI-generated\s+still\s+(?:photographs|photos)\s*:/i.test(clause);
    const labels = /\b(?:exact\s+)?native\s+label\s+(.{1,80}?)\s+on\s+the\s+left\s+panel\s+and\s+(?:the\s+(?:exact\s+)?native\s+label\s+)?(.{1,80}?)\s+on\s+the\s+right\s+panel\b/i.exec(clause);
    const stillComparison = declaration && labels ? {
      labels: [unquote(labels[1]), unquote(labels[2])],
      contain: /\b(?:contained?\s+fit|fit\s*:?\s*contain)\b/i.test(clause),
      noHeadline: /\bno\s+extra\s+headline\b/i.test(clause),
    } : null;
    const dialogue = /\bsays\s+exactly\s*:\s*["“]([^"”]+)["”]/i.exec(clause)?.[1] ?? null;
    return { index, clause, stillComparison, dialogue };
  });
  if (!beats.some(beat => beat.stillComparison) || beats.every(beat => beat.stillComparison)) return null;
  return { total, beats };
}

export function stillComparisonProblems(pkg, scene, contract) {
  const expected = contract.stillComparison;
  const prefix = `${scene?.id ?? `Beat ${contract.index + 1}`}: explicitly requested still-photo comparison`;
  const errors = [];
  if (!scene || !['compare', 'split'].includes(scene.layout) || scene.media_only === true || scene.drawing || scene.composition) {
    return [`${prefix} needs a visible native two-panel compare/split layout at beat ${contract.index + 1}, with the required panel labels; do not replace it with a motion clip or drawing.`];
  }
  if (Number(pkg.format?.height) > Number(pkg.format?.width) * 1.2) errors.push(`${prefix} requires left/right panels, but this format stacks them top/bottom.`);
  const plates = sceneShotPlates(scene);
  if (scene.media?.length !== 2 || plates.length !== 2 || new Set(plates.map(plate => plate.asset)).size !== 2) errors.push(`${prefix} needs two distinct visible generated photographs in scene.media.`);
  const extraRefs = [scene.background?.asset, scene.presenter_asset, ...(scene.foreground ?? []).map(plate => plate.asset)];
  if (extraRefs.some(id => pkg.assets?.[id]?.kind === 'video')) errors.push(`${prefix}: remove the extra background/foreground/presenter video binding. A hidden comparison video is not requested and must not become an additional generation job.`);
  for (let i = 0; i < 2; i++) {
    const plate = plates[i];
    const asset = pkg.assets?.[plate?.asset];
    if (plate?.label !== expected.labels[i]) errors.push(`${prefix}: media[${i}].label must be exactly ${JSON.stringify(expected.labels[i])}.`);
    if (expected.contain && plate?.fit !== 'contain') errors.push(`${prefix}: media[${i}].fit must be contain so the whole photograph remains visible.`);
    if (!asset || asset.kind !== 'image' || asset.gen?.generator !== 'flux3-klein'
      || !['workflows/flux3_klein_t2i.api.json', 'workflows/flux3_klein_ref_edit.api.json'].includes(asset.gen?.workflow)
      || !['pending', 'ready'].includes(asset.status)
      || asset.status === 'ready' && (!asset.file || !asset.sha256)
      || !(Number(asset.status === 'ready' ? asset.media?.width : asset.gen?.inputs?.width) > 0)
      || !(Number(asset.status === 'ready' ? asset.media?.height : asset.gen?.inputs?.height) > 0)) {
      errors.push(`${prefix}: panel ${i + 1} needs a dimensioned planned/ready FLUX 3 Image Klein image; a video, procedural plate, metadata assertion or missing asset is not the requested still photograph.`);
    }
  }
  if (expected.noHeadline && (Object.values(scene.copy ?? {}).some(value => Array.isArray(value) ? value.length : Boolean(value)) || scene.lower_third)) errors.push(`${prefix}: keep only the two panel labels, without extra global copy/lower thirds.`);
  return errors;
}

export function mixedMediaBeatProblems(pkg, contract) {
  if (!contract) return [];
  if (pkg.scenes?.length !== contract.total) return [`Explicit mixed-media brief requires ${contract.total} ordered beats, including its still-photo comparison; preserve that order and count.`];
  return contract.beats.flatMap(beat => {
    const scene = pkg.scenes[beat.index];
    if (beat.stillComparison) return stillComparisonProblems(pkg, scene, beat);
    if (!beat.dialogue) return [];
    const videos = sceneShotPlates(scene).map(plate => pkg.assets?.[plate.asset]);
    const exact = videos.some(video => video?.gen?.generator === 'fasth3-omni'
      && video.gen.direction?.dialogue?.text === beat.dialogue
      && video.gen.direction.dialogue.conditioningText === beat.dialogue
      && pkg.assets?.[video.gen.inputs?.audio]?.gen?.inputs?.text === beat.dialogue);
    return exact ? [] : [`${scene.id}: beat ${beat.index + 1} requires native H3 speech with exact dialogue and measured conditioning for ${JSON.stringify(beat.dialogue)}; a wordless performance, detached narration or LTX substitute does not satisfy this beat.`];
  });
}

export function mixedMediaRepairGuide(pkg, brief) {
  const contract = orderedBeatContract(brief);
  if (!contract) return [];
  return contract.beats.filter(beat => beat.stillComparison).map(beat =>
    `Explicit still beat ${beat.index + 1} of ${contract.total} (${pkg.scenes?.[beat.index]?.id ?? 'missing scene'}): use two distinct original Klein photographs in visible native compare/split media, with labels ${JSON.stringify(beat.stillComparison.labels)}${beat.stillComparison.contain ? ' and fit:contain on both panels' : ''}. This beat is still photographs with native panel-label animation; do not plan a video for it. Preserve the generated motion and exact native dialogue in the other ordered beats.`);
}
