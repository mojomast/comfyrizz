// VM entry point: the uploaded project supplies all props. Studio/demo fixtures
// are not dependencies of a production render bundle.
import React from 'react';
import { Composition, registerRoot } from 'remotion';
import type { CalculateMetadataFunction } from 'remotion';
import { PackageComposition } from './composition';

type Props = Partial<React.ComponentProps<typeof PackageComposition>>;

function RemotePackage(props: Props) {
  if (!props.pkg || !props.timeline) throw new Error('Remote render requires package and timeline props');
  return <PackageComposition {...props} pkg={props.pkg} timeline={props.timeline} />;
}

const metadata: CalculateMetadataFunction<Props> = ({ props }) => {
  if (!props.timeline) throw new Error('Remote render requires measured timeline props');
  const { durationInFrames, fps, width, height } = props.timeline;
  return { durationInFrames, fps, width, height };
};

registerRoot(() => <Composition id="PackageDemo" component={RemotePackage} defaultProps={{}} calculateMetadata={metadata} />);
