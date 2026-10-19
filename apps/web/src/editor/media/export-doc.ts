/**
 * Editor export sidecar. Session, tickets and API tokens are not copied.
 * The package itself stays the source of truth; this file adds source ranges.
 */
import type { ProjectDoc } from '../types.ts';

export interface EditorSidecar {
  version: 1;
  packageId: string;
  editSeq: number;
  takes: ProjectDoc['takes'];
  alignment: ProjectDoc['alignment'];
  captions: ProjectDoc['captions'];
  presenterClips: ProjectDoc['presenterClips'];
}

export function editorExportSidecar(doc: ProjectDoc): EditorSidecar {
  return {
    version: 1,
    packageId: doc.pkg.id,
    editSeq: doc.editSeq,
    takes: doc.takes,
    alignment: doc.alignment,
    captions: doc.captions,
    presenterClips: doc.presenterClips,
  };
}

/** True when a secret string of at least 8 characters appears in the JSON. */
export function containsSecret(value: unknown, secrets: string[]): boolean {
  const text = JSON.stringify(value);
  return secrets.some(secret => secret.length >= 8 && text.includes(secret));
}
