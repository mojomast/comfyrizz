/**
 * Flubber 0.4.2 ships JavaScript only. We use `interpolate`; declare the narrow
 * surface here rather than adding a broader third-party type package.
 */
declare module 'flubber' {
  export type Interpolator = (t: number) => string;
  export function interpolate(
    from: string,
    to: string,
    options?: { maxSegmentLength?: number; string?: boolean },
  ): Interpolator;
  export function separate(from: string, to: string): string[][];
  export function combine(from: string, to: string): string[][];
  const flubber: {
    interpolate: typeof interpolate;
    separate: typeof separate;
    combine: typeof combine;
  };
  export default flubber;
}
