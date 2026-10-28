/**
 * A scripted production for procedure capture: the real Super Easy app runs
 * against it through `page.route('**\/api/**')`. After the plan is approved the
 * snapshot walks through characters, shots, voice, video and a Google Colab
 * session on a timer, then delivers a final video. Nothing leaves the machine
 * and no Google Colab units are spent; the session states are fixture data.
 */
import { readFileSync } from 'node:fs';

const PACKAGE = JSON.parse(readFileSync(new URL('../../../examples/pip-night-shift/package.json', import.meta.url), 'utf8'));
const TIMELINE = JSON.parse(readFileSync(new URL('../../../examples/pip-night-shift/timeline.json', import.meta.url), 'utf8'));

export const PROCEDURE_PRODUCTION_ID = 'prod_procedure_fixture_1';
export const PROCEDURE_PACKAGE_ID = 'pkg_procedure_fixture_1';
export const PROCEDURE_SPEND_CAP = 15;

function tile(label, hue) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180"><rect width="320" height="180" fill="hsl(${hue} 55% 38%)"/><text x="160" y="98" font-family="sans-serif" font-size="22" fill="white" text-anchor="middle">${label}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

const CHARACTERS = [
  { id: 'char_pip', name: 'Pip', image: tile('Pip', 28) },
  { id: 'char_juno', name: 'Juno', image: tile('Juno', 200) },
];
const SHOTS = [
  { id: 'shot_1', image: tile('Shot 1 · FLUX still', 260) },
  { id: 'shot_2', image: tile('Shot 2 · LTX motion', 140) },
  { id: 'shot_3', image: tile('Shot 3 · LTX motion', 320) },
];

/** The production after approval, `phase` 0..PROCEDURE_PHASES-1. */
function phaseSnapshot(phase, finalUrl) {
  const characters = CHARACTERS.map((character, index) => {
    const ready = phase >= 2 || (phase === 1 && index === 0);
    return { id: character.id, name: character.name, status: ready ? 'ready' : 'running', ...(ready ? { imageUrl: character.image } : {}) };
  });
  const shotsReady = phase >= 4 ? 3 : phase === 3 ? 2 : phase === 2 ? 1 : 0;
  const shots = SHOTS.map((shot, index) => (index < shotsReady
    ? { id: shot.id, status: 'approved', url: shot.image }
    : { id: shot.id, status: phase >= 2 ? 'generating' : 'queued' }));
  const usage = phase === 0
    ? { state: 'starting', cap: PROCEDURE_SPEND_CAP }
    : phase <= 3
      ? { state: 'running', used: phase, cap: PROCEDURE_SPEND_CAP }
      : phase === 4 ? { state: 'collecting', used: 3, cap: PROCEDURE_SPEND_CAP } : null;
  const teardown = phase === 5 ? { state: 'stopping' } : phase >= 6 ? { state: 'stopped' } : null;
  const snapshot = {
    characters,
    shots,
    voice: phase >= 4 ? { status: 'done' } : phase >= 3 ? { status: 'running' } : { status: 'waiting' },
    render: phase >= 6 ? { status: 'done' } : phase >= 4 ? { status: 'running', fraction: phase === 4 ? 0.4 : 0.85 } : { status: 'waiting' },
    ...(usage ? { usage } : {}),
    ...(teardown ? { teardown } : {}),
  };
  if (phase >= 6) {
    snapshot.finalVideo = { ready: true, url: finalUrl };
    snapshot.deliveries = [{ id: 'del_procedure_1', status: 'ready', url: finalUrl }];
  }
  return snapshot;
}

export const PROCEDURE_PHASES = 7;

/**
 * @param {{ phaseMs?: number, finalUrl?: string, now?: () => number }} [options]
 */
export function procedureBackend(options = {}) {
  const phaseMs = options.phaseMs ?? 2500;
  const finalUrl = options.finalUrl ?? 'data:video/mp4;base64,AAAA';
  const now = options.now ?? (() => Date.now());
  const calls = [];
  let revision = 3;
  let iteration = null;
  let approvedAt = null;
  let approvedSequence = 0;
  const plans = [];

  function phase() {
    if (approvedAt === null) return -1;
    return Math.min(PROCEDURE_PHASES - 1, Math.floor((now() - approvedAt) / phaseMs));
  }

  function begin() {
    if (approvedAt !== null) return;
    approvedSequence = setupEvents().at(-1)?.sequence ?? 0;
    approvedAt = now();
  }

  function setupEvents() {
    return [
      { productionId: PROCEDURE_PRODUCTION_ID, type: 'production.created', data: {} },
      { productionId: PROCEDURE_PRODUCTION_ID, type: 'brief.updated', data: {} },
      ...plans,
      ...(iteration === null ? [] : [{ productionId: PROCEDURE_PRODUCTION_ID, type: 'iteration.set', data: { policy: iteration.policy } }]),
    ].sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0))
      .map((event, index) => ({ ...event, id: event.id ?? `evt_procedure_setup_${index + 1}`, sequence: index + 1 }));
  }

  /**
   * One journal entry per phase, contiguous after the approval baseline, so
   * the client's watch sees `lastSequence` move and re-reads the snapshot.
   */
  function phaseEvents() {
    const events = [];
    for (let index = 0; index <= phase(); index += 1) {
      events.push({
        id: `evt_procedure_phase_${index}`,
        sequence: approvedSequence + 1 + index,
        productionId: PROCEDURE_PRODUCTION_ID,
        type: 'stage.progress',
        data: { phase: index },
      });
    }
    return events;
  }

  function lastSequence() {
    const phases = phaseEvents();
    return phases.at(-1)?.sequence ?? setupEvents().at(-1)?.sequence ?? 0;
  }

  function snapshot() {
    const production = {
      id: PROCEDURE_PRODUCTION_ID,
      revision,
      briefVersionId: 'brief_procedure',
      scriptVersionId: 'script_procedure',
      shotIds: SHOTS.map((shot) => shot.id),
      characterBindings: CHARACTERS.map((character) => ({ characterId: character.id, name: character.name })),
      iteration: iteration ?? undefined,
      ...(phase() >= 6 ? { latestDeliveryId: 'del_procedure_1' } : {}),
      ...(phase() >= 0 ? phaseSnapshot(phase(), finalUrl) : {}),
    };
    return {
      productionId: PROCEDURE_PRODUCTION_ID,
      production,
      revision,
      lastSequence: lastSequence(),
      // The client keeps a root plan as the production's plan record.
      ...(phase() >= 0 ? { plan: { status: 'done' } } : {}),
      events: [...setupEvents(), ...phaseEvents()],
      gap: false,
      stale: false,
    };
  }

  /** @param {import('@playwright/test').Route} route */
  async function handle(route) {
    const request = route.request();
    const method = request.method();
    const path = new URL(request.url()).pathname;
    const send = (body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

    if (path === '/api/agent' && method === 'POST') {
      calls.push('agent');
      return send({ package: { ...PACKAGE, id: PROCEDURE_PACKAGE_ID }, timeline: TIMELINE, live: true, generatedAssets: {}, svgAssets: [], pendingGpu: [] });
    }
    if (path === '/api/productions' && method === 'POST') {
      calls.push('production');
      return send({ productionId: PROCEDURE_PRODUCTION_ID, production: { id: PROCEDURE_PRODUCTION_ID, revision } });
    }
    if (/^\/api\/productions\/[^/]+\/easy-plan$/u.test(path) && method === 'POST') {
      calls.push('plan');
      revision += 1;
      plans.push({
        sequence: 3 + plans.length * 3,
        data: {
          id: `plan_procedure_${plans.length + 1}`,
          productionId: PROCEDURE_PRODUCTION_ID,
          revision: 3 + plans.length * 3,
          planHash: 'c'.repeat(64),
          reservationCeiling: 0,
          collectAndStopReserve: 0,
          requiredDecisions: [],
          actions: [],
        },
      });
      // Super Easy on This computer re-proposes the plan after the draft level
      // and goes straight on; a plan with no paid actions needs no approval.
      if (iteration !== null) begin();
      return send({ revision });
    }
    if (/^\/api\/productions\/[^/]+$/u.test(path) && method === 'GET') {
      calls.push('snapshot');
      return send(snapshot());
    }
    if (/^\/api\/productions\/[^/]+\/events$/u.test(path) && method === 'GET') {
      calls.push('events');
      return send({ productionId: PROCEDURE_PRODUCTION_ID, lastSequence: lastSequence(), nextAfter: lastSequence(), events: [...setupEvents(), ...phaseEvents()], gap: false, truncated: false });
    }
    if (/^\/api\/productions\/[^/]+\/commands$/u.test(path) && method === 'POST') {
      const command = JSON.parse(request.postData() ?? '{}');
      calls.push(`command:${String(command.kind ?? '')}`);
      revision += 1;
      if (command.kind === 'iteration.set') iteration = { policy: command.payload?.policy, level: 'draft', revision };
      if (command.kind === 'plan.approve') begin();
      return send({ revision });
    }
    if (path === '/api/run' || path.startsWith('/api/run/') || path.endsWith('/spend-cap') || path.endsWith('/actions')) {
      calls.push(`paid:${path}`);
      return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'the procedure fixture never spends' }) });
    }
    calls.push(`other:${path}`);
    return send({});
  }

  return { handle, calls, phase };
}
