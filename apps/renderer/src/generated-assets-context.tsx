import React, { createContext, useContext } from 'react';
import { GENERATED_ASSETS } from './generated-assets';

/** SVG markup resolved at render time for agent-built packages (C5). */
export interface InlineAsset {
  kind: string;
  svg: string;
  width?: number;
  height?: number;
  sanitizerVersion?: string;
}

const GeneratedAssetsContext = createContext<Record<string, InlineAsset>>(GENERATED_ASSETS as unknown as Record<string, InlineAsset>);

export function GeneratedAssetsProvider({ assets, children }: { assets: Record<string, InlineAsset>; children: React.ReactNode }) {
  return <GeneratedAssetsContext.Provider value={assets}>{children}</GeneratedAssetsContext.Provider>;
}

export function useGeneratedAssets(): Record<string, InlineAsset> {
  return useContext(GeneratedAssetsContext);
}
