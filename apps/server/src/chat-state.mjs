import { isDeepStrictEqual as equal } from 'node:util';
import { conversationPlanSchema } from '../../../packages/agent/dist/src/index.js';

/** Rebase known plan fields onto edits made before this turn. A concurrent edit
 * during the turn is still protected by PackageStore's revision lock. */
export function rebaseChatPlans(plan, previousPlan, current) {
  if (!plan || !previousPlan || !current) return { plan, previousPlan };
  const draft = structuredClone(plan);
  const baseline = structuredClone(previousPlan);
  const apply = (old, next, key, value) => {
    if (equal(old[key], value)) return;
    if (equal(next?.[key], old[key]) && next) next[key] = structuredClone(value);
    old[key] = structuredClone(value);
  };
  apply(baseline, draft, 'title', current.title);
  const aspect = current.format.width === current.format.height ? '1:1' : current.format.width < current.format.height ? '9:16' : '16:9';
  apply(baseline, draft, 'aspect', aspect);
  for (const old of baseline.scenes) {
    const scene = current.scenes.find(s => s.id === old.id);
    const next = draft.scenes.find(s => s.id === old.id);
    if (!scene) continue; // The builder preserves manual deletion or reports a conflicting edit.
    const observed = { ...old, layout: scene.layout, headline: scene.copy.headline,
      sub: scene.copy.sub ?? '', body: scene.copy.body ?? '', items: scene.copy.items ?? [],
      narration: scene.narration ?? '', visual: scene.notes ?? old.visual,
      seconds: (scene.preferredFrames ?? old.seconds * current.format.fps) / current.format.fps };
    // Advanced manual layouts/long copy remain in currentProject; do not coerce them into a chat layout.
    if (!conversationPlanSchema.safeParse({ ...baseline, scenes: [observed] }).success) continue;
    for (const key of ['layout', 'headline', 'sub', 'body', 'items', 'narration', 'visual', 'seconds']) apply(old, next, key, observed[key]);
  }
  return { plan: draft, previousPlan: baseline };
}
