// Hybrid-thinking fixture selection. Reuses planning-stress briefs/oracles and
// adds one experiment-only calibration fixture. Does not weaken existing oracles.
import { FIXTURES, PLANNING_MODEL, PLANNING_PROVIDER, fixtureById } from '../planning-stress/fixtures.mjs';

export { PLANNING_MODEL, PLANNING_PROVIDER };

export const CALIBRATION_ID = 'C01';

export const SMOKE_IDS = ['S02', CALIBRATION_ID];

export const MAIN_IDS = [
  'S02',
  'A05',
  'H21',
  'H24',
  'W20',
  CALIBRATION_ID,
  'D13',
  'T25',
  'T30',
  'M10',
  'T29',
  'X33',
];

export const MAIN_COVERAGE = {
  simpleLowConstraint: ['S02', 'A05'],
  narrationCuePhrases: ['H21', 'H24'],
  wordlessNativeSound: ['W20'],
  liveActionHumans: [CALIBRATION_ID],
  remotionOpenerOutro: [CALIBRATION_ID, 'H21', 'H24'],
  structuredVisuals: ['D13'],
  durationClipBounds: ['T25'],
  shotCountMediaCoverage: ['T30'],
  preserveUnrelatedWork: ['M10', 'T29'],
  refusalUnsatisfiable: ['X33'],
  calibration: [CALIBRATION_ID],
};

const FILM = 'generated-film';

/** Experiment-only skater / Remotion calibration brief. Not a planning-stress fixture. */
export const CALIBRATION_FIXTURE = {
  id: CALIBRATION_ID,
  category: 'calibration',
  tags: ['calibration', 'remotion', 'live-action', 'character', 'route:auto'],
  provider: PLANNING_PROVIDER,
  model: PLANNING_MODEL,
  motionModel: 'auto',
  expect: 'plan',
  experimentOnly: true,
  brief: [
    'Create a 12-second live-action generated film in 2 shots of a photorealistic human skateboarder learning to fall safely.',
    'Real humans, natural skin, no clay or animation.',
    'Shot 1: the same skater rolls forward. Shot 2: the same skater falls and recovers.',
    'Native soundscape and foley.',
    'Give the first AI-footage shot an editable Remotion title opener (layout:title, variant:centered)',
    'and the last AI-footage shot a Remotion end card (layout:title, variant:outro).',
    'Keep the same shot ids, generated media and preferredFrames; bookends never add runtime or replace footage.',
    'Do not add standalone title-only scenes. No narration and no dialogue.',
  ].join(' '),
  oracle: {
    kind: FILM,
    sceneCount: 2,
    targetSeconds: 12,
    liveActionHumans: true,
    remotionBookends: true,
    narration: 'forbidden',
  },
};

const BY_ID = new Map(FIXTURES.map(fixture => [fixture.id, fixture]));

export function hybridFixtureById(id) {
  if (id === CALIBRATION_ID) return CALIBRATION_FIXTURE;
  if (BY_ID.has(id)) return fixtureById(id);
  throw new Error(`unknown hybrid fixture ${id}`);
}

export function fixturesFor(ids) {
  return ids.map(hybridFixtureById);
}

export function smokeFixtures() {
  return fixturesFor(SMOKE_IDS);
}

export function mainFixtures() {
  return fixturesFor(MAIN_IDS);
}

export function hybridWantsRemotion(fixture) {
  if (fixture?.oracle?.remotionBookends === true) return true;
  return fixture?.oracle?.kind === 'generated-film' && fixture?.oracle?.narration === 'required';
}
