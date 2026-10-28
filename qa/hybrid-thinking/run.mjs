// Hybrid thinking experiment runner. Planning only. Isolated loopback workers.
// Never calls /api/run, production dispatch, Google Colab, or a GPU.
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertAllowedRequest } from '../planning-stress/run.mjs';
import { chooseUsage, resanitizeEvents } from '../planning-stress/report.mjs';
import {
  HYBRID_PLANNING_CORRECTION_ENV,
  correctionInvokedGeneration,
  emptyUsage,
} from '../../apps/server/src/hybrid-planning-correction.mjs';
import { MAIN_REPS, SMOKE_REPS, mainBudget } from './budget.mjs';
import { MAIN_IDS, SMOKE_IDS, mainFixtures, smokeFixtures } from './fixtures.mjs';
import { collateralDamage, evaluateHybrid, outOfScopeIdChanges } from './oracles.mjs';
import { liveCredential, planningProviderEnv, providerKeyPresent, publicProvider } from './provider.mjs';
import { splitUsage, toHybridRecord, writeHybridReports } from './report.mjs';

export const PORTS = [4531, 4532, 4533, 4534, 4535, 4536];
export const STRESS_ROOT = '/tmp/opencode/comfyrizz-hybrid-thinking';
export const LIMITS = {
  attemptTimeoutMs: 8 * 60 * 1000,
  serverRequestTimeoutMs: 30 * 60 * 1000,
  progressPollMs: 5000,
  suiteDeadlineMs: 60 * 60 * 1000,
  smokeConcurrency: 2,
  mainConcurrency: 2,
};

const repoRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)));

export { providerKeyPresent };

export function assertStressPath(path) {
  const resolved = resolve(path);
  const root = resolve(STRESS_ROOT);
  if (resolved !== root && !resolved.startsWith(`${root}/`)) throw new Error('refusing path outside the hybrid thinking workspace');
  return resolved;
}

export function assertLoopback(base) {
  const url = new URL(base);
  if (url.hostname !== '127.0.0.1') throw new Error('refusing non-loopback host');
  if (!PORTS.includes(Number(url.port))) throw new Error('refusing unexpected port');
  return url;
}

export function workerEnv({ port, runtimeDir, token, baseEnv = {} }) {
  if (!PORTS.includes(port)) throw new Error('refusing unexpected port');
  assertStressPath(runtimeDir);
  const env = {};
  for (const key of ['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'TMPDIR']) {
    if (typeof baseEnv[key] === 'string' && baseEnv[key]) env[key] = baseEnv[key];
  }
  env.COMFYRIZZ_PORT = String(port);
  env.COMFYRIZZ_HOST = '127.0.0.1';
  env.COMFYRIZZ_RUNTIME = runtimeDir;
  env.COMFYRIZZ_TOKEN = token;
  env.COMFYRIZZ_DEMO = 'launch';
  env.COMFYRIZZ_REQUEST_TIMEOUT_MS = String(LIMITS.serverRequestTimeoutMs);
  env[HYBRID_PLANNING_CORRECTION_ENV] = '1';
  const { extra } = planningProviderEnv(baseEnv);
  Object.assign(env, extra);
  return env;
}

export function publicWorkerConfig(env) {
  return {
    port: Number(env.COMFYRIZZ_PORT),
    host: env.COMFYRIZZ_HOST,
    runtimeDir: env.COMFYRIZZ_RUNTIME,
    hybridCorrection: env[HYBRID_PLANNING_CORRECTION_ENV] === '1',
    providerKey: providerKeyPresent(env),
  };
}

export function stopWorkers(pids, kill = (pid, signal) => process.kill(pid, signal)) {
  const stopped = [];
  for (const pid of pids) {
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('refusing to signal an unrecorded pid');
    try {
      kill(pid, 'SIGTERM');
      stopped.push(pid);
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error;
    }
  }
  return stopped;
}

export function fixtureHash(fixtures) {
  const canonical = fixtures.map(fixture => ({
    id: fixture.id,
    brief: fixture.brief,
    motionModel: fixture.motionModel,
    expect: fixture.expect,
    oracle: fixture.oracle,
  }));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export function repoMetadata(root = repoRoot) {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const diff = execFileSync('git', ['diff', 'HEAD'], { cwd: root, encoding: 'utf8' });
  return { commit, diffHash: createHash('sha256').update(diff).digest('hex') };
}

function sleep(ms) {
  return new Promise(resolveSleep => setTimeout(resolveSleep, ms));
}

async function planningFetch(base, method, path, { token, body, timeoutMs }) {
  assertLoopback(base);
  assertAllowedRequest(method, path);
  const generation = correctionInvokedGeneration([], path);
  if (generation.hit) throw new Error(`hard harness failure: generation path ${path}`);
  const url = new URL(`${base}${path}`);
  const payload = body === undefined ? null : JSON.stringify(body);
  const response = await new Promise((resolveRequest, rejectRequest) => {
    const request = httpRequest({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method,
      headers: {
        'content-type': 'application/json',
        'x-comfyrizz-token': token,
        origin: base,
        ...(payload === null ? {} : { 'content-length': Buffer.byteLength(payload) }),
      },
      signal: AbortSignal.timeout(timeoutMs),
    }, incoming => {
      const chunks = [];
      incoming.on('data', chunk => chunks.push(chunk));
      incoming.on('error', rejectRequest);
      incoming.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try {
          json = text ? JSON.parse(text) : {};
        } catch {
          resolveRequest({ status: incoming.statusCode ?? 0, malformed: true, body: {} });
          return;
        }
        resolveRequest({ status: incoming.statusCode ?? 0, malformed: false, body: json });
      });
    });
    request.on('error', rejectRequest);
    if (payload === null) request.end();
    else request.end(payload);
  });
  return response;
}

function countPhaseEvents(events, phase, status) {
  return resanitizeEvents(events).filter(event => event.phase === phase && (!status || event.status === status));
}

function phaseElapsed(events, phase) {
  const done = resanitizeEvents(events).find(event => event.phase === phase && event.status === 'completed' && Number.isFinite(event.durationMs));
  return done ? done.durationMs : null;
}

function modelCallCount(events) {
  return resanitizeEvents(events).filter(event => event.type === 'model_result' || event.type === 'step').length;
}

function usageFrom(http, progressUsage) {
  const chosen = chooseUsage(http.body?.usage, progressUsage);
  const phases = http.body?.usage?.phases;
  return { ...chosen, phases };
}

async function postAgent(worker, { fixture, thinking, sessionId, planningCorrection }) {
  const selected = liveCredential();
  const events = [];
  let progressUsage = null;
  let firstChunkMs = null;
  const started = Date.now();
  const base = `http://127.0.0.1:${worker.port}`;
  const poll = setInterval(async () => {
    try {
      const progress = await planningFetch(base, 'GET', `/api/agent/progress?sessionId=${encodeURIComponent(sessionId)}`, {
        token: worker.token,
        timeoutMs: 10_000,
      });
      if (progress.status === 200) {
        progressUsage = progress.body?.usage ?? progressUsage;
        const safe = resanitizeEvents(progress.body?.recentEvents ?? []);
        events.push(...safe);
        const chunk = safe.find(event => Number.isFinite(event.firstChunkMs));
        if (chunk && firstChunkMs === null) firstChunkMs = chunk.firstChunkMs;
      }
    } catch {
      // Progress is telemetry.
    }
  }, LIMITS.progressPollMs);
  let http;
  try {
    http = await planningFetch(base, 'POST', '/api/agent', {
      token: worker.token,
      timeoutMs: LIMITS.attemptTimeoutMs,
      body: {
        brief: fixture.brief,
        provider: selected.provider,
        model: selected.model,
        motionModel: fixture.motionModel,
        thinking,
        sessionId,
        ...(planningCorrection ? { planningCorrection } : {}),
      },
    });
  } catch (error) {
    http = {
      status: 0,
      transport: true,
      timeout: error?.name === 'TimeoutError' || error?.name === 'AbortError',
      malformed: error?.name === 'SyntaxError',
      body: {},
    };
  } finally {
    clearInterval(poll);
  }
  return { http, events, progressUsage, firstChunkMs, started };
}

function generationViolation(events) {
  return correctionInvokedGeneration(events).hit
    || resanitizeEvents(events).some(event => /\/api\/run|\/api\/pipeline|production\.start|clip_propose/i.test(`${event.name ?? ''} ${event.type ?? ''}`));
}

export function composeArmC(armA, correction, { decision, hybridEval, generationHit, fullReplan }) {
  const aUsage = splitUsage(armA.usage);
  const cUsage = correction ? splitUsage(correction.usage) : splitUsage({ phases: { correction: emptyUsage() } });
  const combined = {
    input: (aUsage.total?.input || 0) + (cUsage.correction?.input || 0),
    output: (aUsage.total?.output || 0) + (cUsage.correction?.output || 0),
    total: 0,
  };
  combined.total = combined.input + combined.output;
  return {
    usage: {
      total: combined,
      initial: aUsage.initial ?? emptyUsage(),
      repair: aUsage.repair ?? emptyUsage(),
      correction: cUsage.correction ?? emptyUsage(),
      source: 'composed',
    },
    elapsedMs: (armA.elapsedMs || armA.timings?.elapsedMs || 0) + (correction?.elapsedMs || 0),
    correctionMs: correction?.elapsedMs ?? 0,
    firstValidDraftMs: armA.firstValidDraftMs ?? armA.timings?.firstValidDraftMs,
    repairMs: armA.repairMs ?? armA.timings?.repairMs,
    hybridEval,
    generationHit,
    fullReplan,
    decision,
  };
}

function judgedToRecord({ fixture, rep, arm, thinking, judged, http, events, usage, timings, extra = {}, selected, concurrency, workerPort }) {
  const transport = http.transport === true || http.status === 429 || http.status === 502 || http.status === 503 || http.status === 504 || http.status === 0;
  const actual = transport && judged.outcome !== 'infrastructure' ? 'infrastructure' : judged.outcome;
  return {
    record: toHybridRecord({
      fixture: fixture.id,
      category: fixture.category,
      rep,
      arm,
      expected: fixture.expect,
      actual,
      httpStatus: Number.isInteger(http.status) ? http.status : null,
      live: judged.live,
      fallback: judged.fallback,
      provider: selected.provider,
      model: selected.model,
      thinking,
      motionModel: fixture.motionModel,
      routes: judged.routes,
      elapsedMs: timings.elapsedMs,
      firstValidDraftMs: timings.firstValidDraftMs,
      repairMs: timings.repairMs,
      correctionMs: timings.correctionMs,
      e2eMs: timings.e2eMs ?? timings.elapsedMs,
      usage,
      modelCalls: modelCallCount(events),
      repairs: countPhaseEvents(events, 'repair', 'started').length,
      corrections: extra.corrections ?? 0,
      retries: extra.retries ?? 0,
      http429: http.status === 429,
      timeout: http.timeout === true,
      providerErrors: transport ? 1 : 0,
      correctionTriggered: extra.correctionTriggered === true,
      correctionSucceeded: extra.correctionSucceeded === true,
      correctionSkippedReason: extra.correctionSkippedReason ?? null,
      needsGlobalReplan: extra.needsGlobalReplan === true,
      fullReplanDiscarded: extra.fullReplanDiscarded === true,
      generationViolation: extra.generationViolation === true,
      validation: judged.validation,
      failures: judged.trigger?.failures ?? judged.failures.map(detail => ({ code: 'QUALITY_OTHER', detail })),
      collateralCount: extra.collateralCount ?? 0,
      collateralCodes: extra.collateralCodes ?? [],
      outOfScopeIdChange: extra.outOfScopeIdChange === true,
      packageIdPreserved: extra.packageIdPreserved ?? null,
      concurrency,
      workerPort,
      reusedArmA: extra.reusedArmA === true,
      reason: judged.failures?.[0] ?? extra.reason ?? null,
    }),
    events,
    judged,
    http,
    transport,
  };
}

async function runArmAB(fixture, worker, { arm, thinking, rep, concurrency }) {
  const selected = liveCredential();
  const sessionId = `hybrid_${arm}_${fixture.id}_${rep}_${randomUUID()}`;
  const posted = await postAgent(worker, { fixture, thinking, sessionId });
  const judged = evaluateHybrid(fixture, {
    status: posted.http.status,
    body: posted.http.body,
    transport: posted.http.transport === true,
  }, selected);
  const usage = usageFrom(posted.http, posted.progressUsage);
  const elapsedMs = Date.now() - posted.started;
  return judgedToRecord({
    fixture,
    rep,
    arm,
    thinking,
    judged,
    http: posted.http,
    events: posted.events,
    usage,
    timings: {
      elapsedMs,
      e2eMs: elapsedMs,
      firstValidDraftMs: phaseElapsed(posted.events, 'initial') ?? elapsedMs,
      repairMs: phaseElapsed(posted.events, 'repair'),
      correctionMs: null,
    },
    extra: {
      retries: 0,
    },
    selected,
    concurrency,
    workerPort: worker.port,
  });
}

export function planArmC(armA, fixture) {
  if (armA.record.actual === 'infrastructure' || armA.judged.trigger.infrastructure) {
    return { action: 'skip', reason: 'infrastructure', reuse: true };
  }
  return armA.judged.trigger.decision;
}

async function runArmC(fixture, worker, armA, { rep, concurrency }) {
  const selected = liveCredential();
  const decision = planArmC(armA, fixture);
  if (decision.action === 'skip') {
    const reused = structuredClone(armA.record);
    reused.arm = 'C';
    reused.thinking = 'hybrid';
    reused.reusedArmA = true;
    reused.corrections = 0;
    reused.correction = {
      triggered: false,
      succeeded: false,
      skippedReason: decision.reason,
      needsGlobalReplan: false,
      fullReplanDiscarded: false,
      generationViolation: false,
    };
    reused.usage = {
      ...reused.usage,
      correction: emptyUsage(),
    };
    reused.timings = { ...reused.timings, correctionMs: 0, e2eMs: reused.timings.e2eMs };
    return { record: reused, events: [], judged: armA.judged, http: armA.http, transport: false };
  }
  if (decision.action === 'global_replan') {
    const reused = structuredClone(armA.record);
    reused.arm = 'C';
    reused.thinking = 'hybrid';
    reused.reusedArmA = true;
    reused.correction = {
      triggered: false,
      succeeded: false,
      skippedReason: decision.reason,
      needsGlobalReplan: true,
      fullReplanDiscarded: false,
      generationViolation: false,
    };
    reused.timings = { ...reused.timings, correctionMs: 0 };
    return { record: reused, events: [], judged: armA.judged, http: armA.http, transport: false };
  }

  const packageId = armA.http.body?.package?.id;
  if (typeof packageId !== 'string') {
    return judgedToRecord({
      fixture,
      rep,
      arm: 'C',
      thinking: 'enabled',
      judged: armA.judged,
      http: { status: 0, transport: true, body: {} },
      events: [],
      usage: armA.record.usage,
      timings: { elapsedMs: armA.record.timings.elapsedMs, e2eMs: armA.record.timings.elapsedMs, correctionMs: 0, firstValidDraftMs: armA.record.timings.firstValidDraftMs, repairMs: armA.record.timings.repairMs },
      extra: { reason: 'arm A package id missing; correction not started', needsGlobalReplan: true, reusedArmA: true },
      selected,
      concurrency,
      workerPort: worker.port,
    });
  }

  const sessionId = `hybrid_C_${fixture.id}_${rep}_${randomUUID()}`;
  const posted = await postAgent(worker, {
    fixture,
    thinking: 'enabled',
    sessionId,
    planningCorrection: {
      packageId,
      failures: armA.judged.trigger.failures,
    },
  });
  const events = posted.events;
  const generationHit = generationViolation(events);
  if (generationHit) {
    const record = structuredClone(armA.record);
    record.arm = 'C';
    record.actual = 'infrastructure';
    record.reason = 'hard harness failure: correction invoked generation or production';
    record.correction = {
      triggered: true,
      succeeded: false,
      skippedReason: null,
      needsGlobalReplan: false,
      fullReplanDiscarded: false,
      generationViolation: true,
    };
    return { record: toHybridRecord({ ...record, fixture: fixture.id, category: fixture.category, rep, arm: 'C', expected: fixture.expect, actual: 'infrastructure', generationViolation: true, correctionTriggered: true, reason: record.reason, usage: composeArmC(armA.record, { usage: usageFrom(posted.http, posted.progressUsage), elapsedMs: Date.now() - posted.started }, { decision, hybridEval: armA.judged, generationHit: true, fullReplan: false }).usage, elapsedMs: record.timings.elapsedMs, e2eMs: record.timings.elapsedMs + (Date.now() - posted.started), workerPort: worker.port, concurrency }), events, judged: armA.judged, http: posted.http, transport: false, hardFailure: true };
  }

  const fullReplan = posted.http.body?.hybrid?.fullReplan === true || posted.http.body?.hybrid?.discarded === true
    || events.some(event => event.name === 'storyboard.propose');
  const judged = fullReplan
    ? armA.judged
    : evaluateHybrid(fixture, { status: posted.http.status, body: posted.http.body, transport: posted.http.transport === true }, selected);
  const composed = composeArmC(armA.record, {
    usage: usageFrom(posted.http, posted.progressUsage),
    elapsedMs: Date.now() - posted.started,
  }, { decision, hybridEval: judged, generationHit: false, fullReplan });
  const ids = outOfScopeIdChanges(armA.judged.observation, judged.observation, armA.judged.trigger.failures);
  const collateral = collateralDamage(armA.judged.trigger, judged.trigger);
  const pass = judged.outcome === 'pass' || judged.outcome === 'expected_refusal_pass';
  return judgedToRecord({
    fixture,
    rep,
    arm: 'C',
    thinking: 'enabled',
    judged: fullReplan ? { ...judged, outcome: armA.judged.outcome } : judged,
    http: fullReplan ? armA.http : posted.http,
    events,
    usage: composed.usage,
    timings: {
      elapsedMs: composed.elapsedMs,
      e2eMs: composed.elapsedMs,
      firstValidDraftMs: armA.record.timings.firstValidDraftMs,
      repairMs: armA.record.timings.repairMs,
      correctionMs: composed.correctionMs,
    },
    extra: {
      corrections: 1,
      correctionTriggered: true,
      correctionSucceeded: pass && !fullReplan,
      needsGlobalReplan: fullReplan,
      fullReplanDiscarded: fullReplan,
      generationViolation: false,
      collateralCount: collateral.count,
      collateralCodes: collateral.introducedCodes,
      outOfScopeIdChange: ids.outOfScope,
      packageIdPreserved: !ids.packageIdChanged,
      reusedArmA: fullReplan,
    },
    selected,
    concurrency,
    workerPort: worker.port,
  });
}

function linkBuild(sourceRoot, worktree) {
  const links = [
    'node_modules',
    'packages/agent/dist',
    'packages/llm/dist',
    'packages/planner/dist',
    'packages/vector/dist',
    'packages/sources/dist',
    'packages/tts/dist',
  ];
  for (const workspace of ['packages', 'apps']) {
    const root = join(sourceRoot, workspace);
    if (!existsSync(root)) continue;
    for (const name of readdirSync(root)) {
      links.push(join(workspace, name, 'node_modules'));
    }
  }
  for (const relative of links) {
    const from = join(sourceRoot, relative);
    const to = join(worktree, relative);
    if (!existsSync(from) || existsSync(to)) continue;
    mkdirSync(dirname(to), { recursive: true });
    symlinkSync(from, to);
  }
}

function ensureWorktree(sourceRoot) {
  const dest = assertStressPath(join(STRESS_ROOT, 'src'));
  if (!existsSync(join(dest, 'apps', 'server', 'src', 'index.mjs'))) {
    mkdirSync(dirname(dest), { recursive: true });
    execFileSync('git', ['worktree', 'add', '--detach', dest, 'HEAD'], { cwd: sourceRoot, stdio: 'ignore' });
  }
  linkBuild(sourceRoot, dest);
  return dest;
}

async function waitForHealth(port, pid) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await planningFetch(`http://127.0.0.1:${port}`, 'GET', '/api/health', { token: 'health', timeoutMs: 2000 });
      if (response.status === 200 && response.body?.ok === true) return;
    } catch {
      // booting
    }
    if (pid) {
      try { process.kill(pid, 0); } catch { throw new Error(`worker on ${port} exited before health`); }
    }
    await sleep(250);
  }
  throw new Error(`worker on ${port} did not become healthy`);
}

function startWorker(worktree, { port, runtimeDir, token, baseEnv }) {
  assertStressPath(runtimeDir);
  mkdirSync(runtimeDir, { recursive: true });
  const child = spawn(process.execPath, ['apps/server/src/index.mjs'], {
    cwd: worktree,
    env: workerEnv({ port, runtimeDir, token, baseEnv }),
    stdio: ['ignore', 'ignore', 'ignore'],
    detached: true,
  });
  child.unref();
  return { port, pid: child.pid, token, runtimeDir };
}

async function bootWorkers(worktree, runId, baseEnv, count) {
  const workers = [];
  try {
    for (const port of PORTS.slice(0, count)) {
      const runtimeDir = assertStressPath(join(STRESS_ROOT, 'runtimes', runId, String(port)));
      const token = randomBytes(32).toString('hex');
      const worker = startWorker(worktree, { port, runtimeDir, token, baseEnv });
      workers.push(worker);
      await waitForHealth(port, worker.pid);
    }
    const pidPath = assertStressPath(join(STRESS_ROOT, 'results', runId, 'workers.json'));
    mkdirSync(dirname(pidPath), { recursive: true });
    writeFileSync(pidPath, `${JSON.stringify(workers.map(worker => ({ port: worker.port, pid: worker.pid })), null, 2)}\n`);
    return workers;
  } catch (error) {
    stopWorkers(workers.map(worker => worker.pid));
    throw error;
  }
}

async function runTrialPair(fixture, worker, { rep, concurrency }) {
  const armA = await runArmAB(fixture, worker, { arm: 'A', thinking: 'disabled', rep, concurrency });
  const armC = await runArmC(fixture, worker, armA, { rep, concurrency });
  return [armA, armC];
}

async function runTrials(fixtures, workers, { reps, concurrency, deadlineAt }) {
  const results = [];
  const jobs = [];
  for (const fixture of fixtures) {
    for (let rep = 1; rep <= reps; rep += 1) jobs.push({ fixture, rep });
  }
  let cursor = 0;
  const free = workers.slice();
  const waiters = [];
  const running = new Set();

  function acquire() {
    const worker = free.pop();
    if (worker) return Promise.resolve(worker);
    return new Promise(resolveWorker => waiters.push(resolveWorker));
  }
  function release(worker) {
    const waiter = waiters.shift();
    if (waiter) waiter(worker);
    else free.push(worker);
  }

  async function one(job) {
    const worker = await acquire();
    try {
      const pair = await runTrialPair(job.fixture, worker, { rep: job.rep, concurrency });
      results.push(...pair);
    } finally {
      release(worker);
    }
  }

  while (cursor < jobs.length || running.size > 0) {
    if (Date.now() >= deadlineAt) break;
    while (running.size < concurrency && cursor < jobs.length && Date.now() < deadlineAt) {
      const job = jobs[cursor];
      cursor += 1;
      const promise = one(job).finally(() => running.delete(promise));
      running.add(promise);
    }
    if (running.size === 0) break;
    await Promise.race(running);
  }
  await Promise.all([...running]);
  return results;
}

async function runBTrials(fixtures, workers, { reps, concurrency, deadlineAt }) {
  const results = [];
  const jobs = [];
  for (const fixture of fixtures) {
    for (let rep = 1; rep <= reps; rep += 1) jobs.push({ fixture, rep });
  }
  let cursor = 0;
  const free = workers.slice();
  const waiters = [];
  const running = new Set();
  function acquire() {
    const worker = free.pop();
    if (worker) return Promise.resolve(worker);
    return new Promise(resolveWorker => waiters.push(resolveWorker));
  }
  function release(worker) {
    const waiter = waiters.shift();
    if (waiter) waiter(worker);
    else free.push(worker);
  }
  async function one(job) {
    const worker = await acquire();
    try {
      results.push(await runArmAB(job.fixture, worker, { arm: 'B', thinking: 'enabled', rep: job.rep, concurrency }));
    } finally {
      release(worker);
    }
  }
  while (cursor < jobs.length || running.size > 0) {
    if (Date.now() >= deadlineAt) break;
    while (running.size < concurrency && cursor < jobs.length && Date.now() < deadlineAt) {
      const job = jobs[cursor];
      cursor += 1;
      const promise = one(job).finally(() => running.delete(promise));
      running.add(promise);
    }
    if (running.size === 0) break;
    await Promise.race(running);
  }
  await Promise.all([...running]);
  return results;
}

function blockedRecords(fixtures, reps, reason, selected) {
  const records = [];
  for (const fixture of fixtures) {
    for (let rep = 1; rep <= reps; rep += 1) {
      for (const arm of ['A', 'B', 'C']) {
        records.push(toHybridRecord({
          fixture: fixture.id,
          category: fixture.category,
          rep,
          arm,
          expected: fixture.expect,
          actual: 'not_run',
          provider: selected?.provider ?? null,
          model: selected?.model ?? null,
          thinking: arm === 'A' ? 'disabled' : 'enabled',
          motionModel: fixture.motionModel,
          reason,
          failures: [],
        }));
      }
    }
  }
  return records;
}

function writeOutcome(outDir, records, events, extra) {
  return writeHybridReports(outDir, records, {
    ...extra,
    events,
    date: new Date().toISOString(),
  });
}

async function main() {
  const wantMain = process.argv.includes('--main');
  const runId = `${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-${randomBytes(3).toString('hex')}`;
  const outDir = assertStressPath(join(STRESS_ROOT, 'results', runId));
  mkdirSync(outDir, { recursive: true });
  const metadata = repoMetadata();
  const selected = liveCredential();
  const publicSelected = publicProvider(selected);
  const fixtures = wantMain ? mainFixtures() : smokeFixtures();
  const reps = wantMain ? MAIN_REPS : SMOKE_REPS;
  const budget = mainBudget();
  const config = {
    runId,
    commit: metadata.commit,
    diffHash: metadata.diffHash,
    fixtureHash: fixtureHash(fixtures),
    fixtureIds: fixtures.map(fixture => fixture.id),
    smokeIds: SMOKE_IDS,
    mainIds: MAIN_IDS,
    reps,
    ports: PORTS,
    limits: LIMITS,
    budget,
    ...publicSelected,
    live: Boolean(selected),
    mainRequested: wantMain,
    mainApproved: process.env.HYBRID_THINKING_MAIN === '1',
  };

  if (wantMain && process.env.HYBRID_THINKING_MAIN !== '1') {
    const records = blockedRecords(fixtures, reps, 'main live run is gated; HYBRID_THINKING_MAIN is not 1', publicSelected);
    writeOutcome(outDir, records, {}, {
      runId,
      status: 'gated',
      commit: metadata.commit,
      ...publicSelected,
      mode: publicSelected.mode,
      fixtures: MAIN_IDS,
      reps: MAIN_REPS,
      budget,
      blocked: `main run gated. requests=${budget.maxRequests} hardTokenBudget=${budget.hardTokenBudget} estimatedTokens=${budget.estimatedTokens}`,
      config,
    });
    console.log('hybrid thinking main run gated (operator approval required)');
    console.log(`maxRequests=${budget.maxRequests} hardTokenBudget=${budget.hardTokenBudget} estimatedTokens=${budget.estimatedTokens}`);
    console.log(`results=${outDir}`);
    process.exitCode = 2;
    return;
  }

  if (!selected) {
    const records = blockedRecords(fixtures, reps, 'no live provider key in the operator environment; live planning was not started', publicSelected);
    writeOutcome(outDir, records, {}, {
      runId,
      status: 'blocked',
      commit: metadata.commit,
      ...publicSelected,
      mode: null,
      fixtures: fixtures.map(fixture => fixture.id),
      reps,
      budget,
      blocked: 'COMFYRIZZ_CUSTOM_API_KEY / DEEPSEEK_API_KEY / OPENCODE_GO_API_KEY / OPENCODE_API_KEY unset',
      config,
    });
    console.log('hybrid thinking blocked: provider key missing');
    console.log(`fixtures=${fixtures.map(fixture => fixture.id).join(',')} reps=${reps}`);
    console.log(`results=${outDir}`);
    process.exitCode = 2;
    return;
  }

  const worktree = ensureWorktree(repoRoot);
  let workers = [];
  try {
    const concurrency = wantMain ? LIMITS.mainConcurrency : LIMITS.smokeConcurrency;
    workers = await bootWorkers(worktree, runId, process.env, concurrency);
    const deadlineAt = Date.now() + LIMITS.suiteDeadlineMs;
    const ac = await runTrials(fixtures, workers, { reps, concurrency, deadlineAt });
    const b = await runBTrials(fixtures, workers, { reps, concurrency, deadlineAt });
    const finished = [...ac, ...b];
    const records = finished.map(item => item.record);
    const events = {};
    for (const item of finished) {
      events[`${item.record.arm}-${item.record.fixture}-r${item.record.rep}.json`] = item.events;
    }
    const hard = finished.some(item => item.hardFailure || item.record.correction?.generationViolation);
    const infrastructure = records.some(record => record.actual === 'infrastructure') || hard;
    const unexpected = records.some(record => record.actual === 'fail' || record.actual === 'missing_actionable_refusal');
    writeOutcome(outDir, records, events, {
      runId,
      status: hard ? 'harness_failure' : infrastructure ? 'infrastructure' : unexpected ? 'oracle_failures' : 'complete',
      commit: metadata.commit,
      ...publicSelected,
      mode: publicSelected.mode,
      fixtures: fixtures.map(fixture => fixture.id),
      reps,
      budget,
      concurrency: [{ concurrency, at: new Date().toISOString(), phase: wantMain ? 'main' : 'smoke' }],
      config: { ...config, live: true },
    });
    console.log(`hybrid thinking ${hard ? 'harness failure' : infrastructure ? 'infrastructure' : unexpected ? 'oracle failures' : 'complete'}`);
    console.log(`provider=${publicSelected.provider} model=${publicSelected.model} mode=${publicSelected.mode}`);
    console.log(`results=${outDir}`);
    process.exitCode = hard || infrastructure ? 2 : unexpected ? 1 : 0;
  } finally {
    stopWorkers(workers.map(worker => worker.pid));
  }
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  main().catch(error => {
    console.error(`hybrid thinking failed: ${error?.message ?? 'unknown error'}`);
    process.exitCode = 2;
  });
}

export {
  generationViolation,
  judgedToRecord,
  runArmAB,
  runArmC,
};
