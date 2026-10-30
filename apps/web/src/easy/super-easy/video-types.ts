import { VIDEO_TYPES } from '../../../../../packages/agent/src/video-types.ts';
import type { VideoType } from '../../../../../packages/agent/src/video-types.ts';

export { VIDEO_TYPES };
export type { VideoType };

/** The shared browser-safe planner catalog also owns all card and prompt copy. */
export const VIDEO_TYPE_LIST = VIDEO_TYPES;

export function isVideoType(value: unknown): value is VideoType {
  return typeof value === 'string' && VIDEO_TYPE_LIST.some(type => type.id === value);
}

export function videoTypeMetadata(value: VideoType | null | undefined): (typeof VIDEO_TYPE_LIST)[number] | null {
  return VIDEO_TYPE_LIST.find(type => type.id === value) ?? null;
}
