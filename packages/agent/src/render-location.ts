/** Where the pipeline assembles the final MP4. The editor owns this setting. */
export const RENDER_LOCATIONS = ['local', 'colab'] as const;
export type RenderLocation = (typeof RENDER_LOCATIONS)[number];
export const DEFAULT_RENDER_LOCATION: RenderLocation = 'local';
