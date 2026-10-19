import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SCENE_ID = /^s[A-Za-z0-9_-]{0,63}$/;

export function editorPath(runtimeDir, id) {
  if (!/^[A-Za-z0-9_.-]+$/.test(id)) throw new Error('invalid package id');
  return join(runtimeDir, 'editor', `${id}.json`);
}

export function readEditor(runtimeDir, id) {
  try {
    return JSON.parse(readFileSync(editorPath(runtimeDir, id), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/** Version 1 sidecar. Null means the request did not include one. */
export function validateEditor(value) {
  if (value == null) return { editor: null };
  if (typeof value !== 'object' || Array.isArray(value)) return { error: 'editor must be an object' };
  if (value.version !== 1) return { error: 'editor.version must be 1' };
  const overrides = value.captionOverrides ?? [];
  if (!Array.isArray(overrides)) return { error: 'editor.captionOverrides must be an array' };
  const captionOverrides = [];
  for (const item of overrides) {
    if (!item || typeof item.sceneId !== 'string' || !SCENE_ID.test(item.sceneId) || !Number.isInteger(item.index) || item.index < 0 || typeof item.text !== 'string' || item.text.length > 2000) {
      return { error: 'bad caption override' };
    }
    captionOverrides.push({ sceneId: item.sceneId, index: item.index, text: item.text });
  }
  return { editor: { version: 1, captionOverrides } };
}

export function writeEditor(runtimeDir, id, editor) {
  const target = editorPath(runtimeDir, id);
  mkdirSync(join(runtimeDir, 'editor'), { recursive: true });
  const temp = `${target}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(editor, null, 2));
  renameSync(temp, target);
}
