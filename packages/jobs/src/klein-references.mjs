// Local workflow capacity, not the model family's theoretical reference limit.
export const KLEIN_REF_CAP = 2;
export const REF_EDIT_WORKFLOW = 'workflows/flux3_klein_ref_edit.api.json';
export const REF2_EDIT_WORKFLOW = 'workflows/flux3_klein_ref2_edit.api.json';

const slots = {
  [REF_EDIT_WORKFLOW]: ['image', 'reference'],
  [REF2_EDIT_WORKFLOW]: ['image', 'reference', '_reference_2'],
  'workflows/flux3_klein_img2img.api.json': ['image'],
  'workflows/character_lora_klein.api.json': ['image', 'reference'],
  'workflows/character_identity_pulid.api.json': ['image', 'reference'],
};
const referenceKey = key => key === 'image' || key === 'images' || key === 'reference' || /^_?reference_/.test(key);

/** Validate authored inputs, or resolved job inputs against their actual graph slots.
 * Reject unsupported representations instead of silently truncating references. */
export function kleinReferenceProblem(params = {}, { workflow, fileInputs = [], paramsSource } = {}) {
  params ??= {};
  fileInputs = Array.isArray(fileInputs) ? fileInputs : [];
  const fail = detail => `PLAN_KLEIN_REFERENCE_UNSUPPORTED: ${detail}; local Klein workflows support at most two connected references. Use one reference or the supported ordered two-reference edit; no source may be silently dropped.`;
  for (const key of Object.keys(params)) {
    if (!referenceKey(key)) continue;
    if (key === 'images' || /^_?reference_/.test(key) && !['reference_2', '_reference_2'].includes(key)) return fail(`unsupported reference input ${key}`);
    if (typeof params[key] !== 'string' || !params[key]) return fail(`${key} must name one image`);
  }
  if (params.image !== undefined && params.reference !== undefined) return fail('image and reference alias the same first slot; set only one');
  if (params.reference_2 !== undefined && params._reference_2 !== undefined) return fail('reference_2 and _reference_2 alias the same second slot; set only one');
  if ((params.reference_2 !== undefined || params._reference_2 !== undefined) && !params.image && !params.reference) return fail('the second reference requires a first image or reference');
  if (workflow !== undefined) {
    if (paramsSource && [...Object.keys(params), ...fileInputs.map(input => input?.param)].some(key => typeof key === 'string' && referenceKey(key))) return fail('custom parameter maps cannot certify reference-slot wiring');
    const allowed = Object.hasOwn(slots, workflow) ? slots[workflow] : [];
    for (const key of [...Object.keys(params), ...fileInputs.map(input => input?.param)]) {
      if (typeof key === 'string' && referenceKey(key) && !allowed.includes(key)) return fail(`${key} is not connected by ${workflow}`);
    }
    const inputs = fileInputs.filter(input => referenceKey(input?.param ?? ''));
    if (inputs.length > KLEIN_REF_CAP || new Set(inputs.map(input => input.param)).size !== inputs.length
      || inputs.some(input => input.param === 'image') && inputs.some(input => input.param === 'reference')) return fail('fileInputs repeats or exceeds connected reference slots');
  }
  return null;
}
