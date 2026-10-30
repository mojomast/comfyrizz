import type { EditablePackage } from '../../../src/editor/commands.ts';

// Minimal r22 Neon After Rain reproduction from motion-type-effects/runtime/packages/
// pkg_5d3dcd43c0f29a02.json and evidence/neon-plan-audit.json. Pending 129/24 sources,
// not the unreachable 97-frame predecessors. Preserve source model/conditioning IDs.
export function neon(): EditablePackage {
  const videoIds = ['a_vid_2053072394fc3628', 'a_vid_d602ba4c6c83bcfd', 'a_vid_3f00f54fb9c272fd'];
  const imageIds = ['a_img_b8f48a1085054795', 'a_img_b27f2f28a95e879c', 'a_img_f31b2038e52ea225'];
  return {
    id: 'pkg_5d3dcd43c0f29a02', revision: 22, title: 'Neon After Rain',
    format: { fps: 30, width: 1920, height: 1080 },
    duration: { mode: 'target', targetFrames: 360, exact: true },
    theme: { palette: ['#05060a', '#0e1420', '#22e0ff', '#ff2fb0'], text: '#f4fbff', text_muted: '#8fa3b8', text_on_accent: '#05060a', font: 'Inter' },
    voice: { enabled: false, engine: 'none' },
    scenes: ['AFTER DARK', 'FOLLOW THE LIGHT', 'MAKE IT ELECTRIC'].map((headline, i) => ({
      id: `shot${i + 1}`, layout: 'title', preferredFrames: 120,
      variant: i === 2 ? 'outro' : 'centered', copy: { headline },
      background: { asset: videoIds[i] }, foreground: [],
      ...(i < 2 ? { transitionOut: { type: i ? 'push' : 'wipe', direction: 'right' } } : {}),
      motion: i === 1 ? { entry: 'pop', ease: 'land', spring: 'settle', stagger: 'word', emphasis: 'none' }
        : { recipe: 'kinetic', entry: 'maskRise', ease: 'enter', spring: i ? 'heavy' : 'snap', emphasis: i ? 'hero' : 'keyword' },
    })),
    assets: Object.fromEntries(videoIds.map((id, i) => [id, {
      kind: 'video', status: 'pending', origin: 'generated', media: { fps: 24, frames: 129, audio: 'muted' },
      gen: { generator: 'ltx25', model: 'ltx-2.5', workflow: 'workflows/ltx25_i2v_2stage.api.json',
        inputs: { image: imageIds[i], frames: 129, fps: 24, seed: 0, strength: 0.85 } },
    }])),
  };
}
