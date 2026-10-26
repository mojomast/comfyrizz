import { ITERATION_PRESETS } from '../../../server/src/productions/iteration.mjs';
import type { Compute, Level, StepId } from './types.ts';
import { COPY } from './copy.ts';

interface Stage {
  takes: number;
  rounds: number;
  auditions: number;
  pick: string;
}

interface Preset {
  stages: Record<'script' | 'voice' | 'keyframe' | 'video', Stage>;
}

const DRAFT_SUMMARY = 'One version of everything. Fastest. Picked for you.';
const EVERY_STAGE = ' You pick at every stage.';
const BEST_VERSION = ' You pick the best version.';
const PICKED_FOR_YOU = ' Picked for you.';

const PRESETS = ITERATION_PRESETS as Record<'draft' | 'balanced' | 'director', Preset>;

export function levelIntro(compute: Compute): string {
  return compute === 'colab' ? COPY.level.introColab : COPY.level.intro;
}

export function compactStepName(step: StepId): string {
  return step === 'level' ? COPY.level.compactName : COPY.steps[step];
}

export function describeLevel(preset: Preset): string {
  const stages = preset.stages;
  const all = [stages.script, stages.voice, stages.keyframe, stages.video];
  const oneVersion = all.every((stage) => (
    stage.takes === 1 && stage.rounds === 1 && stage.auditions === 0 && stage.pick === 'auto'
  ));
  if (oneVersion) return DRAFT_SUMMARY;

  const parts: string[] = [];
  const scriptCount = stages.script.takes;
  const voiceOptions = stages.voice.auditions;
  const imageOptions = stages.keyframe.auditions;
  const videoCount = stages.video.takes;
  const rounds = stages.video.rounds;
  if (scriptCount > 1) parts.push(`${scriptCount} scripts`);
  if (voiceOptions > 0) parts.push(`${voiceOptions} voice options`);
  if (imageOptions > 0) parts.push(`${imageOptions} image options`);
  const versions = videoCount * rounds;
  if (versions > 1) {
    parts.push(rounds > 1
      ? `up to ${versions} versions of each shot over ${rounds} rounds`
      : `${versions} versions of each shot`);
  }

  const asked = all.filter((stage) => stage.pick === 'ask').length;
  const hero = all.some((stage) => stage.pick === 'hero');
  const ending = asked === 4 ? EVERY_STAGE : asked > 0 || hero ? BEST_VERSION : PICKED_FOR_YOU;
  return `${parts.join(', ')}.${ending}`;
}

export function summaryForLevel(level: Level): string {
  if (level === 'custom') return COPY.level.summaries.custom;
  return describeLevel(PRESETS[level]);
}
