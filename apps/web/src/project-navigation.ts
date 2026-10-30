import type { UiMode } from './ui/prefs.ts';

/** Mode changes are document transitions, not just a preference toggle. */
export function createProjectNavigation(options: {
  search(): string;
  packageId(): string | null;
  currentMode?(): UiMode;
  flush(): Promise<void>;
  hasUnsavedChanges(): boolean;
  load(packageId: string): Promise<void>;
  commit(mode: UiMode, search: string): void;
}) {
  let pending: Promise<void> = Promise.resolve();
  let studioSearch: string | null = null;

  function navigate(mode: UiMode, packageId?: string | null): Promise<void> {
    // Serialize requests so a slower previous package cannot replace a newer
    // project after its view has opened.
    const transition = pending.then(async () => {
      const search = options.search();
      const params = new URLSearchParams(search);
      // The live editor document is authoritative: Easy can advance to a new
      // package without rewriting a stale `package=` in the address bar.
      const target = packageId?.trim() || options.packageId() || params.get('package')?.trim();
      // A repeated click on the active view must not add a duplicate history
      // entry for the project already on screen.
      if (
        options.currentMode?.() === mode
        && params.get('package') === target
        && (mode === 'advanced' ? params.get('view') === 'editor' : params.get('view') !== 'editor')
        && search === `?${params.toString()}`
      ) return;
      if (!target) throw new Error('Choose a project before opening the editor.');
      await options.flush();
      if (options.hasUnsavedChanges()) throw new Error('Your changes have not saved yet. Save this project before switching views.');
      if (options.packageId() !== target) await options.load(target);
      if (options.packageId() !== target) throw new Error(`The requested project ${target} did not load.`);

      params.set('package', target);
      if (mode === 'advanced') {
        if (params.get('view') !== 'editor') studioSearch = params.toString();
        params.set('view', 'editor');
        params.delete('step');
      } else {
        // Return to the same simple/studio surface, retaining URL-scoped guest,
        // conversation and production context. Cold editor links return to Easy.
        const previous = new URLSearchParams(studioSearch ?? '');
        params.delete('view');
        params.delete('step');
        if (previous.get('package') === target) {
          if (previous.get('view') === 'super-easy') params.set('view', 'super-easy');
          if (previous.has('step')) params.set('step', previous.get('step')!);
        }
        // No stored step: Easy derives it from the loaded package's facts, so a
        // cold editor deep link never jumps back to an early studio step.
      }
      options.commit(mode, `?${params.toString()}`);
    });
    pending = transition.catch(() => undefined);
    return transition;
  }

  return { navigate };
}
