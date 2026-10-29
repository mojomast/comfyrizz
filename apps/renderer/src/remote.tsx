// VM entry point: the uploaded project supplies all props. Studio/demo fixtures
// are not dependencies of a production render bundle.
import React from 'react';
import { Composition, registerRoot } from 'remotion';
import type { CalculateMetadataFunction } from 'remotion';
import { PackageComposition } from './composition';
import { compositionDurationInFrames } from './audio-mix-model.js';

type Props = Partial<React.ComponentProps<typeof PackageComposition>>;

function RemotePackage(props: Props) {
  if (!props.pkg || !props.timeline) throw new Error('Remote render requires package and timeline props');
  return <PackageComposition {...props} pkg={props.pkg} timeline={props.timeline} />;
}

const metadata: CalculateMetadataFunction<Props> = ({ props }) => {
  if (!props.timeline || !props.pkg) throw new Error('Remote render requires package and measured timeline props');
  const { fps, width, height } = props.timeline;
  return { durationInFrames: compositionDurationInFrames(props.pkg, props.timeline), fps, width, height };
};

registerRoot(() => <Composition id="PackageDemo" component={RemotePackage} defaultProps={{}} calculateMetadata={metadata} />);
