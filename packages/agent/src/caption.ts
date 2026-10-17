/** Deterministic FLUX caption expansion for planned image jobs (spec 6.4). */
export interface CaptionInput {
  intent: string;
  palette?: string[];
  style?: string;
  aspect?: '16:9' | '1:1' | '4:5' | '9:16';
  cutout?: boolean;
}

const NEGATIVE = 'no text, no lettering, no logos, no watermarks, no UI chrome';

export function expandFluxCaption(input: CaptionInput): string {
  const palette = input.palette?.length ? `palette ${input.palette.join(', ')}` : 'a restrained launch palette';
  const style = input.style ?? 'editorial 3D render, soft volumetric light, subtle grain';
  const framing = input.aspect === '1:1' ? 'square composition' : input.aspect === '9:16' ? 'vertical composition' : input.aspect === '4:5' ? 'portrait composition' : 'wide 16:9 composition';
  const cutout = input.cutout ? 'isolated subject on a transparent background, clean silhouette' : 'full-bleed scene';
  return `${input.intent.trim().replace(/[.!?]+$/, '')}. ${style}; ${palette}; ${framing}; ${cutout}; ${NEGATIVE}.`;
}
