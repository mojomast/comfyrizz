/**
 * Editor export sidecar. Session, tickets and API tokens are not copied.
 * The package itself stays the source of truth; this file adds source ranges.
 */
import type { ProjectDoc } from '../commands.ts';

export interface EditorExportSidecar {
  version: 1;
  packageId: string;
  editSeq: number;
  takes: NonNullable<ProjectDoc['editor']['takes']>;
  alignment: NonNullable<ProjectDoc['editor']['alignment']>;
  captions: ProjectDoc['editor']['captionOverrides'];
  presenterClips: NonNullable<ProjectDoc['editor']['presenterClips']>;
}

export function editorExportSidecar(doc: ProjectDoc): EditorExportSidecar {
  return {
    version: 1,
    packageId: String(doc.package.id ?? ''),
    editSeq: doc.editSequence,
    takes: doc.editor.takes ?? {},
    alignment: doc.editor.alignment ?? {},
    captions: doc.editor.captionOverrides,
    presenterClips: doc.editor.presenterClips ?? {},
  };
}

/** True when a secret string of at least 8 characters appears in the JSON. */
export function containsSecret(value: unknown, secrets: string[]): boolean {
  const text = JSON.stringify(value);
  return secrets.some(secret => secret.length >= 8 && text.includes(secret));
}
