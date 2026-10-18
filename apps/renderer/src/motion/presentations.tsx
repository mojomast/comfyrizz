// MS3 step 2: the Remotion transition presentations for the MS2 vocabulary.
//
// `@remotion/transitions` invokes a presentation component once per side of the overlap,
// tagged `presentationDirection` ('exiting' or 'entering'). We build one component that asks the
// pure maths in `transitions.js` for the frame's styles and applies the matching side, so no
// transition state lives in React.
import React from 'react';
import { AbsoluteFill } from 'remotion';
import type {
  TransitionPresentation,
  TransitionPresentationComponentProps,
} from '@remotion/transitions';
import { transitionStyle } from './transitions.js';

export type MotionPresentationProps = {
  type: string;
  direction?: string;
  packageDirection?: string;
  width: number;
  height: number;
};

const MotionTransition: React.FC<TransitionPresentationComponentProps<MotionPresentationProps>> = ({
  children,
  presentationProgress,
  presentationDirection,
  passedProps,
}) => {
  const style = transitionStyle(passedProps.type, presentationProgress, passedProps);
  const side = presentationDirection === 'entering' ? style.entering : style.outgoing;
  return <AbsoluteFill style={side as React.CSSProperties}>{children}</AbsoluteFill>;
};

/** A presentation for `type` that resolves direction and frame size from the package. */
export function motionPresentation(props: MotionPresentationProps): TransitionPresentation<MotionPresentationProps> {
  return { component: MotionTransition, props };
}

/**
 * The presentation a scene's compiled `transitionOut` should use, or `null` for a hard cut
 * (none/cut, and anything with no overlap). Width/height come from the composition.
 */
export function presentationFor(
  transition: { type?: string; direction?: string } | undefined,
  packageDirection: string | undefined,
  width: number,
  height: number,
): TransitionPresentation<MotionPresentationProps> | null {
  const type = transition?.type;
  if (!type || type === 'none' || type === 'cut') return null;
  return motionPresentation({ type, direction: transition?.direction, packageDirection, width, height });
}
