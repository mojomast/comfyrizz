/** Mounts the script/audio panel. Uses CA-1's store when it has published one. */
import './panel.css';
import { demoSamples, demoStore } from './demo.ts';
import { mountScriptAudioPanel } from './panel.ts';
import type { StandInEditorStore } from '../store.ts';

const host = document.getElementById('script-audio-panel');
if (host) {
  const published = (window as unknown as { __comfyrizzEditorStore?: StandInEditorStore }).__comfyrizzEditorStore;
  // TEMPORARY: a local store until CA-1 assigns window.__comfyrizzEditorStore.
  mountScriptAudioPanel(host, published ?? demoStore(), demoSamples());
}
