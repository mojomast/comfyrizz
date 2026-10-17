/**
 * Asset-type router (spec 6.2/6.10). SVG is the default for procedural,
 * text-light art that a vector renderer can check on CPU. FLUX is for
 * illustrative/photo-like pixels, textures and plates. Stock and uploads are
 * explicit fallbacks, never an automatic choice for generated art.
 */
export type AssetRoute = 'assets.generate_svg' | 'assets.generate_image' | 'assets.sketch_to_render' | 'assets.search' | 'assets.upload';

export interface AssetNeed {
  sceneId: string;
  /** Optional provider hint from the model (icon, diagram, illustration, texture, ...). */
  kind?: string;
  intent: string;
  animated?: boolean;
  transparent?: boolean;
  source?: 'generate' | 'openverse' | 'stock' | 'upload';
  licensePolicy?: string;
  /**
   * Requested visual style (clay, glass, editorial, ...). A style on a
   * hero/background/diagram role becomes an SVG base plus a Klein reference edit
   * (GPU test 2: the reference edit is the best way to style an agent SVG).
   */
  style?: string;
}

export interface RouteDecision {
  sceneId: string;
  tool: AssetRoute;
  kind: string;
  reason: string;
}

const SVG_KINDS = new Set(['icon', 'diagram', 'chart', 'graph', 'pattern', 'logo', 'vector', 'shape', 'glyph', 'badge', 'arrow', 'decoration', 'animated-vector', 'vector-anim']);
const IMAGE_KINDS = new Set(['illustration', 'texture', 'background', 'photo', 'photograph', 'cutout', 'nebula', 'art', 'artwork', 'hero', 'plate', 'image', 'painting']);
/** Icon roles never get a style pass: a styled icon is a generated image, not a vector. */
const ICON_KINDS = new Set(['icon', 'glyph', 'badge', 'arrow', 'logo', 'ui-element']);
const ICON_WORDS = /\b(icon|icons|glyph|badge|arrow|logo|ui element)\b/i;
/** Kinds assets.sketch_to_render accepts: an SVG base makes sense for each. */
const RESTYLE_KINDS = new Set(['diagram', 'hero', 'background', 'illustration', 'plate', 'pattern', 'chart', 'vector', 'vector-anim']);
const RESTYLE_WORDS = /\b(diagram|flowchart|hero|background|illustration|plate|pattern|chart|graph|vector|schematic|infographic)\b/i;

const SVG_WORDS = /\b(icon|icons|diagram|flowchart|chart|graph|pattern|vector|logo|badge|glyph|arrow|schematic|infographic|ui element|shape)\b/i;
const IMAGE_WORDS = /\b(illustration|illustrative|photo|photograph|realistic|texture|background|nebula|galaxy|painting|artwork|art|cinematic|3d render|cutout|transparent png|plate|hero image)\b/i;

function normalizeKind(kind: string | undefined): string {
  return (kind ?? '').trim().toLowerCase().replace(/[\s_]+/g, '-');
}

export function routeAsset(need: AssetNeed): RouteDecision {
  const intent = need.intent.trim();
  const kind = normalizeKind(need.kind);
  const text = `${kind} ${intent}`;
  if (need.source === 'upload') return { sceneId: need.sceneId, tool: 'assets.upload', kind: kind || 'upload', reason: 'explicit upload fallback' };
  if (need.source === 'openverse' || need.source === 'stock') return { sceneId: need.sceneId, tool: 'assets.search', kind: kind || 'stock', reason: 'explicit stock fallback' };
  const iconish = ICON_KINDS.has(kind) || ICON_WORDS.test(intent);
  const restylable = RESTYLE_KINDS.has(kind) || (kind === '' && RESTYLE_WORDS.test(intent));
  if (need.style && !iconish && restylable) {
    return {
      sceneId: need.sceneId,
      tool: 'assets.sketch_to_render',
      kind: RESTYLE_KINDS.has(kind) ? kind : 'diagram',
      reason: `${kind || 'diagram'} wants the "${need.style}" style: SVG base + Klein reference edit`,
    };
  }
  if (SVG_KINDS.has(kind)) return { sceneId: need.sceneId, tool: 'assets.generate_svg', kind, reason: `${kind} is procedural vector art` };
  if (IMAGE_KINDS.has(kind)) return { sceneId: need.sceneId, tool: 'assets.generate_image', kind, reason: `${kind} needs raster imagery` };
  if (need.transparent) return { sceneId: need.sceneId, tool: 'assets.generate_image', kind: kind || 'cutout', reason: 'transparent raster cutout' };
  if (need.animated && SVG_WORDS.test(text)) return { sceneId: need.sceneId, tool: 'assets.generate_svg', kind: kind || 'animated-vector', reason: 'animated vector part (frame-driven SVG)' };
  const svg = SVG_WORDS.test(text);
  const image = IMAGE_WORDS.test(text);
  if (svg && !image) return { sceneId: need.sceneId, tool: 'assets.generate_svg', kind: kind || 'icon', reason: 'intent is procedural/text-light' };
  if (image) return { sceneId: need.sceneId, tool: 'assets.generate_image', kind: kind || 'illustration', reason: 'intent is illustrative/photo-like' };
  if (need.animated) return { sceneId: need.sceneId, tool: 'assets.generate_svg', kind: kind || 'animated-vector', reason: 'default animated vector' };
  return { sceneId: need.sceneId, tool: 'assets.generate_svg', kind: kind || 'icon', reason: 'default for simple generated art' };
}

export function routeBrief(brief: string): RouteDecision[] {
  const needs: AssetNeed[] = [];
  const parts = brief.split(/\band\b|[.;\n,]+/i).map(part => part.trim()).filter(Boolean);
  for (const [index, part] of parts.entries()) {
    if (!/\b(icon|diagram|chart|pattern|illustration|photo|texture|background|nebula|art|logo|badge|cutout)\b/i.test(part)) continue;
    needs.push({ sceneId: `s${index + 1}`, intent: part, kind: undefined });
  }
  if (needs.length === 0) needs.push({ sceneId: 's1', intent: brief });
  return needs.map(routeAsset);
}
