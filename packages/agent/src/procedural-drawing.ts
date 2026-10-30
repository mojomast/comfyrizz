import { z } from 'zod';

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const coordinate = z.number().finite().min(0).max(1000);
const frame = z.number().int().min(0).max(108000);
const point = z.tuple([coordinate, coordinate]);
const timing = { start: frame, end: frame, opacity: z.number().min(0).max(1).optional() };
const path = z.object({ type: z.literal('path'), points: z.array(point).min(2).max(200), color, width: z.number().min(0.5).max(50), ...timing, erase: z.boolean().optional(), marker: z.boolean().optional() }).strict();
const polygon = z.object({ type: z.literal('polygon'), points: z.array(point).min(3).max(200), color, ...timing }).strict();
const text = z.object({ type: z.literal('text'), x: coordinate, y: coordinate, text: z.string().min(1).max(200), color, size: z.number().min(5).max(200), ...timing }).strict();
const rect = z.object({ type: z.literal('rect'), x: coordinate, y: coordinate, width: coordinate, height: coordinate, color, ...timing }).strict();
const circle = z.object({ type: z.literal('circle'), x: coordinate, y: coordinate, radius: coordinate, color, ...timing }).strict();
const element = z.discriminatedUnion('type', [path, polygon, text, rect, circle]);
const validateTiming = (elements: Array<{ start: number; end: number }>, ctx: z.RefinementCtx) => {
  elements.forEach((element, index) => {
    if (element.end < element.start) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index, 'end'], message: 'end must be at least start' });
  });
};
export const drawingSchema = z.object({ background: color, elements: z.array(element).min(1).max(500), source: z.object({ id: z.string().max(80), sha256: z.string().regex(/^[a-f0-9]{64}$/), description: z.string().max(8000) }).strict().optional() }).strict().superRefine((drawing, ctx) => {
  drawing.elements.forEach((element, index) => {
    if (element.end < element.start) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['elements', index, 'end'], message: 'end must be at least start' });
  });
});
export const drawingToolSchema = z.object({ scene_id: z.string().min(1), drawing: drawingSchema }).strict();

/** Append to the current scene, or start from a previous scene's held final state. */
export const extendDrawingToolSchema = z.object({
  scene_id: z.string().min(1),
  source_scene_id: z.string().min(1).optional(),
  remove: z.array(z.number().int().min(0)).max(120).optional(),
  erase: z.array(z.object({ index: z.number().int().min(0), start: frame, end: frame }).strict().refine(value => value.end >= value.start, 'end must be at least start')).max(120).optional(),
  elements: z.array(element).max(120).superRefine(validateTiming).optional(),
}).strict();

// Use ordinary JSON Schema unions and homogeneous point arrays for provider compatibility.
// Cross-field timing constraints are described here and enforced by Zod.
const colorJson = { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' };
const coordJson = { type: 'number', minimum: 0, maximum: 1000 };
const frameJson = { type: 'integer', minimum: 0, maximum: 108000 };
const commonJson = { color: colorJson, start: frameJson, end: { ...frameJson, description: 'Must be >= start.' }, opacity: { type: 'number', minimum: 0, maximum: 1 } };
const pointsJson = (minItems: number) => ({ type: 'array', minItems, maxItems: 200, items: { type: 'array', minItems: 2, maxItems: 2, items: coordJson } });
const variant = (type: string, properties: Record<string, unknown>, required: string[]) => ({
  type: 'object', properties: { type: { type: 'string', enum: [type] }, ...commonJson, ...properties },
  required: ['type', 'color', 'start', 'end', ...required], additionalProperties: false,
});
export const drawingElementJsonSchema = { anyOf: [
  variant('path', { points: pointsJson(2), width: { type: 'number', minimum: 0.5, maximum: 50 }, marker: { type: 'boolean' }, erase: { type: 'boolean' } }, ['points', 'width']),
  variant('polygon', { points: pointsJson(3) }, ['points']),
  variant('text', { x: coordJson, y: coordJson, text: { type: 'string', minLength: 1, maxLength: 200 }, size: { type: 'number', minimum: 5, maximum: 200 } }, ['x', 'y', 'text', 'size']),
  variant('rect', { x: coordJson, y: coordJson, width: coordJson, height: coordJson }, ['x', 'y', 'width', 'height']),
  variant('circle', { x: coordJson, y: coordJson, radius: coordJson }, ['x', 'y', 'radius']),
] };
export const drawingJsonSchema = {
  type: 'object', properties: { background: colorJson, elements: { type: 'array', minItems: 1, maxItems: 120, items: drawingElementJsonSchema } },
  required: ['background', 'elements'], additionalProperties: false,
};

export function extendDrawing(args: z.infer<typeof extendDrawingToolSchema>, source?: any) {
  if (!source?.drawing) throw new Error('source scene has no drawing');
  const original = drawingSchema.parse(source.drawing);
  const copying = args.source_scene_id !== undefined;
  let elements: any[] = structuredClone(original.elements);
  if (copying) {
    const lastFrame = Number(source.preferredFrames) - 1;
    if (!Number.isInteger(lastFrame) || lastFrame < 0) throw new Error('source scene has no valid duration');
    if (elements.some(element => element.end > lastFrame)) throw new Error('source drawing is still animating on its last frame; finish its animation before copying');
    if (elements.some(element => element.type === 'path' && element.marker && element.end === lastFrame)) throw new Error('source marker is visible on its last frame; end its animation before copying');
    elements = elements.map(element => {
      if (element.type === 'path' && element.erase) return null;
      const { marker: _marker, erase: _erase, ...rest } = element;
      return { ...rest, start: 0, end: 0 };
    });
  }
  const remove = new Set(args.remove ?? []);
  const erasures = new Map<number, { index: number; start: number; end: number }>();
  for (const item of args.erase ?? []) {
    if (erasures.has(item.index) || remove.has(item.index)) throw new Error(`duplicate or conflicting element index ${item.index}`);
    erasures.set(item.index, item);
  }
  for (const index of [...remove, ...erasures.keys()]) {
    if (index >= elements.length || !elements[index]) throw new Error(`element index ${index} is not present in the source`);
  }
  elements = elements.flatMap((element, index) => {
    if (!element || remove.has(index)) return [];
    const erasure = erasures.get(index);
    if (!erasure) return [element];
    if (!copying) throw new Error('erase requires source_scene_id so the path is visible at the start');
    if (element.type !== 'path') throw new Error(`element ${index} is not a path; erasure only applies to paths`);
    return [{ ...element, start: erasure.start, end: erasure.end, erase: true }];
  });
  return drawingSchema.parse({ background: original.background, elements: [...elements, ...(args.elements ?? [])], ...(original.source ? { source: original.source } : {}) });
}
