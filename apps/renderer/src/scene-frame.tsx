import { createContext, useContext, type ReactNode } from 'react';
import { useCurrentFrame } from 'remotion';

const SceneFrameContext = createContext<number | null>(null);

/**
 * Draw scene-local motion at `frame` without moving the composition clock.
 * Audio, captions and the timeline length stay on the real frame.
 */
export function SceneFrameProvider({ frame, children }: { frame: number; children: ReactNode }) {
  return <SceneFrameContext.Provider value={frame}>{children}</SceneFrameContext.Provider>;
}

/** Scene-local frame, or the money-shot hold when a provider is set. */
export function useSceneFrame(): number {
  const actual = useCurrentFrame();
  const override = useContext(SceneFrameContext);
  return override === null ? actual : override;
}
