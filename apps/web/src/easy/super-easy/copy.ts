export { fill } from '../copy.ts';

type DeepReadonly<T> = {
  readonly [K in keyof T]: T[K] extends string ? T[K] : DeepReadonly<T[K]>;
};

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

export const COPY = deepFreeze({
  home: {
    title: 'Make a video',
    promptLabel: 'What is your video about?',
    promptPlaceholder: 'A friendly robot who learns to bake bread',
    generate: 'Generate',
    starting: 'Starting…',
    tryExample: 'Try an example',
    moreControl: 'I want more control',
    emptyPrompt: 'Tell us what you want to make first.',
  },
  making: {
    title: 'Making your video',
    subtitle: 'Watch it come together. Keep this page open.',
    overall: 'All done',
    waiting: 'Waiting',
    working: 'Working',
    done: 'Done',
  },
  stages: {
    plan: 'Plan',
    characters: 'Characters',
    shots: 'Shots',
    voice: 'Voice',
    video: 'Video',
  },
  gallery: {
    empty: 'Your pictures and clips will show up here.',
    loading: 'Getting your pictures and clips ready…',
    error: "Couldn't make {stage}. Try again.",
    retry: 'Try again',
  },
  done: {
    title: 'Your video is ready!',
    download: 'Download',
    again: 'Make another',
  },
  googleColab: {
    title: 'Use Google Colab?',
    body: 'Google Colab makes your video on Google computers. It uses Google Colab units, up to your spend cap.',
    confirm: 'Use Google Colab',
    cancel: 'Use this computer',
  },
});

export function keys(): string[] {
  const found: string[] = [];
  const walk = (value: object, prefix: string) => {
    for (const [key, child] of Object.entries(value)) {
      const path = prefix === '' ? key : `${prefix}.${key}`;
      if (typeof child === 'string') found.push(path);
      else if (child !== null && typeof child === 'object') walk(child, path);
    }
  };
  walk(COPY, '');
  return found.sort();
}
