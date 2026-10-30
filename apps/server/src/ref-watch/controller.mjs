// RW08: Reference Watch controller. Stills render first. A video job stays held
// until every keyframe it uses is accepted or overridden. Regen jobs reserve
// the same production budget ledger self-repair spends from, and only after
// the regen estimate. Nothing here calls Google Colab, Comfy, or the network.
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cacheKeyFor } from '../../../../packages/jobs/src/plan.mjs';
import {
  REF_DECISION_SCHEMA,
  REF_POLICY_DEFAULTS,
  REF_REVIEW_REQUEST_SCHEMA,
  REF_VERDICT_SCHEMA,
  refGateOpen,
  refRegenJobCap,
  validateRefDecision,
  validateRefReviewRequest,
  validateRefVerdict,
} from '../../../../packages/schema/src/ref-review.mjs';
import { refuseStaleVideo } from '../productions/keyframe-staleness.mjs';
import { decide as decideDefault } from './decide.mjs';
import { estimateRegen } from './estimate.mjs';
import * as steerDefault from './steer.mjs';
import { runT0Checks } from './t0-checks.mjs';
import { createRefWatcher } from './watcher.mjs';

const VIDEO_KINDS = new Set(['plate', 'upscale', 'presenter']);
const STEER_PLACEHOLDER = '<steer>';
const REPLACE_PLACEHOLDER = '<replace-ref>';
const SECRET = /(api[_-]?key|token|secret|authorization|bearer)\s*[:=]\s*\S+/gi;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function redact(value) {
  return String(value ?? 'reviewer failed').replace(SECRET, (match, label) => `${label}=[redacted]`);
}

function isVideo(job) {
  return job?.outputKind === 'video' || VIDEO_KINDS.has(job?.kind) || /\.(?:mp4|webm)$/i.test(job?.output ?? '');
}

function isStill(job) {
  if (!isObject(job) || isVideo(job)) return false;
  return job.kind === 'still' || job.outputKind === 'image' || job.batch === 'stills' || /\.(?:png|jpe?g|webp)$/i.test(job.output ?? '');
}

function freshSeed(current, attempt) {
  const base = Number.isFinite(Number(current)) ? Number(current) >>> 0 : 0;
  let seed = (base + 1 + attempt) >>> 0;
  if (seed === base) seed = (base + 1) >>> 0;
  return seed;
}

function identityHardFail(verdict) {
  return Array.isArray(verdict?.checks) && verdict.checks.some((check) => (
    check?.dimension === 'identity' && check.pass === false && check.severity === 'hard'
  ));
}

function t0HardFail(verdict) {
  return verdict?.overall === 'fail' && Array.isArray(verdict.checks)
    && verdict.checks.some((check) => check?.pass === false && check.severity === 'hard');
}

function holdUnits(estimate) {
  const units = estimate?.units;
  if (typeof units === 'number' && Number.isFinite(units) && units >= 0) return units;
  if (units && typeof units.high === 'number' && Number.isFinite(units.high) && units.high >= 0) return units.high;
  if (units && typeof units.expected === 'number' && Number.isFinite(units.expected) && units.expected >= 0) return units.expected;
  return null;
}

function charactersFor(job) {
  if (!Array.isArray(job?.characters)) return [];
  return job.characters.filter((character) => isObject(character) && character.characterId && character.identityLock)
    .map((character) => ({
      characterId: character.characterId,
      identityLock: character.identityLock,
      ...(character.wardrobeState ? { wardrobeState: character.wardrobeState } : {}),
    }));
}

function errorVerdict(seed) {
  return {
    schema: REF_VERDICT_SCHEMA,
    jobId: seed.jobId,
    keyframeSha256: seed.keyframeSha256,
    reviewer: 'pi',
    overall: 'error',
    checks: [],
    fixHints: [],
  };
}

export function createRefWatchController({
  jobsDoc,
  reviewer,
  t0 = runT0Checks,
  decide = decideDefault,
  steer = steerDefault,
  estimate = estimateRegen,
  submitJobs,
  budgetLedger,
  onEvent,
  policy = REF_POLICY_DEFAULTS,
  iteration,
  receiptsDir,
  now = () => new Date().toISOString(),
  reviewTimeoutMs = 60_000,
  measure,
  currentKeyframeSha,
} = {}) {
  if (!isObject(jobsDoc)) throw new TypeError('createRefWatchController requires a jobsDoc object');
  if (typeof submitJobs !== 'function') throw new TypeError('createRefWatchController requires submitJobs');

  const jobs = (Array.isArray(jobsDoc.jobs) ? jobsDoc.jobs : []).filter(isObject);
  const live = new Map(jobs.map((job) => [job.id, structuredClone(job)]));
  const productionId = jobsDoc.productionId ?? jobsDoc.packageId ?? null;
  const runId = typeof jobsDoc.runId === 'string' && jobsDoc.runId ? jobsDoc.runId : 'run';
  const caps = { ...REF_POLICY_DEFAULTS, ...(policy ?? {}) };
  const stillJobs = jobs.filter(isStill);
  const stillIds = new Set(stillJobs.map((job) => job.id));
  const stillCount = stillJobs.length;
  const steerPrompt = steer?.steerPrompt ?? steerDefault.steerPrompt;
  const fillDecision = steer?.fillDecision ?? steerDefault.fillDecision;
  const chooseReplacementRef = steer?.chooseReplacementRef ?? steerDefault.chooseReplacementRef;

  const states = new Map();
  const acceptedSha = new Map();
  const acceptedStills = [];
  const submittedVideos = new Set();
  const refusedVideos = new Set();
  let regenJobsUsed = 0;
  let started = false;
  let chain = Promise.resolve();

  for (const job of stillJobs) {
    states.set(job.id, { state: 'pending', attempt: 0, identityFailures: 0 });
  }

  function emit(event) {
    if (typeof onEvent !== 'function') return;
    onEvent({
      productionId,
      at: typeof now === 'function' ? now() : null,
      ...event,
    });
  }

  function keyframeDeps(video) {
    const inputs = Array.isArray(video?.fileInputs) ? video.fileInputs : [];
    const deps = [];
    for (const input of inputs) {
      if (isObject(input) && input.from === 'job' && stillIds.has(input.job)) deps.push(input.job);
    }
    return deps;
  }

  function isGatedVideo(job) {
    return isVideo(job) && keyframeDeps(job).length > 0;
  }

  const gatedVideos = jobs.filter(isGatedVideo);

  function currentSha(jobId) {
    if (typeof currentKeyframeSha === 'function') return currentKeyframeSha(jobId) ?? null;
    if (isObject(currentKeyframeSha) && typeof currentKeyframeSha[jobId] === 'string') return currentKeyframeSha[jobId];
    const value = live.get(jobId)?.currentKeyframeSha256;
    return typeof value === 'string' && value ? value : null;
  }

  function stalenessRefusal(video, jobId) {
    const current = currentSha(jobId);
    const reviewed = acceptedSha.get(jobId);
    if (!current || !reviewed) return null;
    return refuseStaleVideo({ videoJob: video, keyframeSha256: reviewed, currentKeyframeSha256: current });
  }

  function persist(keyframeSha256, verdicts, decision) {
    if (typeof receiptsDir !== 'string' || !receiptsDir) return;
    const dir = join(receiptsDir, 'ref-review');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `${keyframeSha256}.json`);
    const body = {
      schema: 'comfyrizz.ref-review.evidence/v1',
      keyframeSha256,
      imageSha256: keyframeSha256,
      verdicts,
      decision,
    };
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, file);
  }

  function ensure(jobId) {
    if (!states.has(jobId)) states.set(jobId, { state: 'pending', attempt: 0, identityFailures: 0 });
    return states.get(jobId);
  }

  function failClosed(seed, reason, verdicts = []) {
    const record = ensure(seed.jobId);
    record.state = 'held';
    const decision = {
      schema: REF_DECISION_SCHEMA,
      jobId: seed.jobId,
      keyframeSha256: seed.keyframeSha256,
      action: 'escalate',
      reason: redact(reason),
      attempt: record.attempt,
    };
    const stored = verdicts.length > 0 ? verdicts : [errorVerdict(seed)];
    persist(seed.keyframeSha256, stored, decision);
    emit({
      type: 'ref_review_error',
      jobId: seed.jobId,
      keyframeSha256: seed.keyframeSha256,
      state: 'held',
      decision,
    });
    emit({
      type: 'ref_gate_held',
      jobId: seed.jobId,
      keyframeSha256: seed.keyframeSha256,
      state: 'held',
    });
  }

  function holdDecision(seed, decision, verdicts) {
    const record = ensure(seed.jobId);
    record.state = 'held';
    persist(seed.keyframeSha256, verdicts, decision);
    emit({
      type: 'ref_review_verdict',
      jobId: seed.jobId,
      keyframeSha256: seed.keyframeSha256,
      state: 'held',
      verdict: verdicts[verdicts.length - 1],
      decision,
    });
    emit({
      type: 'ref_gate_held',
      jobId: seed.jobId,
      keyframeSha256: seed.keyframeSha256,
      state: 'held',
    });
  }

  async function maybeReleaseVideos() {
    const ready = [];
    for (const video of gatedVideos) {
      if (submittedVideos.has(video.id) || refusedVideos.has(video.id)) continue;
      const deps = keyframeDeps(video);
      if (!deps.every((id) => refGateOpen(states.get(id)?.state))) continue;
      let refusal = null;
      for (const id of deps) {
        refusal = stalenessRefusal(video, id);
        if (refusal) break;
      }
      if (refusal) {
        refusedVideos.add(video.id);
        emit({
          type: 'ref_gate_held',
          jobId: video.id,
          keyframeSha256: refusal.keyframeSha256,
          state: 'held',
          refusal,
        });
        continue;
      }
      ready.push(structuredClone(live.get(video.id) ?? video));
      submittedVideos.add(video.id);
    }
    if (ready.length > 0) await submitJobs({ batch: 'video', jobs: ready });
  }

  function rememberAccepted(job, seed, verdict) {
    const characters = charactersFor(job);
    acceptedStills.push({
      jobId: job.id,
      characterId: characters[0]?.characterId,
      imagePath: seed.imagePath,
      state: 'accepted',
      identityPassed: !identityHardFail(verdict),
      acceptedAt: acceptedStills.length + 1,
      verdict,
    });
  }

  function applyReplaceRef(job, replaceRef) {
    if (job.params && typeof job.params.reference === 'string') job.params.reference = replaceRef;
    if (job.params && Array.isArray(job.params.refs) && job.params.refs.length > 0) {
      job.params.refs = [replaceRef, ...job.params.refs.slice(1)];
    }
    job.fileInputs = (Array.isArray(job.fileInputs) ? job.fileInputs : []).map((input) => {
      if (!isObject(input)) return input;
      if (input.param === 'reference' || input.param === '_reference_1') return { ...input, path: replaceRef };
      return input;
    });
  }

  function budgetFits(hold) {
    if (!budgetLedger || typeof budgetLedger.reserve !== 'function' || typeof budgetLedger.status !== 'function') return false;
    const status = budgetLedger.status();
    if (status.capped !== true) return true;
    return typeof status.available === 'number' && status.available >= hold;
  }

  async function reviewSeed(seed) {
    const record = ensure(seed.jobId);
    if (record.state === 'held' || record.state === 'accepted' || record.state === 'overridden') return;
    const job = live.get(seed.jobId);
    if (!job) return;
    record.state = 'reviewing';

    const measured = typeof measure === 'function'
      ? await measure({ job, imagePath: seed.imagePath, attempt: record.attempt })
      : null;
    const plannedWidth = job.dims?.width ?? measured?.width ?? 1024;
    const plannedHeight = job.dims?.height ?? measured?.height ?? 576;
    const characters = charactersFor(job);
    const request = {
      schema: REF_REVIEW_REQUEST_SCHEMA,
      productionId: productionId ?? 'production',
      runId,
      jobId: seed.jobId,
      shotId: job.shotId || job.scene || job.asset || job.id,
      keyframeSha256: seed.keyframeSha256,
      imagePath: seed.imagePath,
      width: measured?.width ?? plannedWidth,
      height: measured?.height ?? plannedHeight,
      plannedWidth,
      plannedHeight,
      prompt: job.params?.prompt || job.prompt || 'untitled still',
      attempt: record.attempt,
      characters,
    };
    if (!validateRefReviewRequest(request).ok) {
      failClosed(seed, 'review request was not valid');
      return;
    }

    const verdicts = [];
    let t0Verdict;
    try {
      t0Verdict = await t0(request, { stats: measured?.stats ?? { mean: 40, stddev: 12 }, identity: measured?.identity });
    } catch (error) {
      failClosed(seed, error?.message ?? 't0 checks failed');
      return;
    }
    if (!validateRefVerdict(t0Verdict).ok) {
      failClosed(seed, 't0 verdict was not valid', [errorVerdict(seed)]);
      return;
    }
    verdicts.push(t0Verdict);

    let verdict = t0Verdict;
    if (!t0HardFail(t0Verdict)) {
      let reviewed;
      try {
        reviewed = await callReviewer(request, { path: seed.imagePath, sha256: seed.keyframeSha256 });
      } catch (error) {
        const reason = error?.code === 'REVIEW_TIMEOUT' ? 'reviewer timed out' : (error?.message ?? 'reviewer failed');
        failClosed(seed, reason, [...verdicts, errorVerdict(seed)]);
        return;
      }
      if (!validateRefVerdict(reviewed).ok || reviewed.overall === 'error') {
        const invalid = validateRefVerdict(reviewed).ok ? reviewed : errorVerdict(seed);
        failClosed(seed, 'reviewer returned an unusable verdict', [...verdicts, invalid]);
        return;
      }
      verdict = reviewed;
      verdicts.push(verdict);
    }

    if (identityHardFail(verdict)) record.identityFailures += 1;
    let decision = decide({
      verdict,
      attempt: record.attempt,
      regenJobsUsed,
      stillCount,
      identityFailures: record.identityFailures,
      policy: caps,
    });
    if (!validateRefDecision(decision).ok) {
      decision = {
        schema: REF_DECISION_SCHEMA,
        jobId: seed.jobId,
        keyframeSha256: seed.keyframeSha256,
        action: 'escalate',
        reason: 'decision was not valid',
        attempt: record.attempt,
      };
    }

    if (decision.action === 'reprompt' || decision.action === 'replace_ref') {
      const previous = live.get(seed.jobId);
      const nextPrompt = steerPrompt({
        previousPrompt: previous.params?.prompt ?? previous.prompt ?? '',
        verdict,
        characters,
      });
      const replaceRef = chooseReplacementRef({
        characterId: characters[0]?.characterId,
        primaryImage: previous.primaryImage ?? previous.params?.reference,
        acceptedStills,
      });
      decision = fillDecision(decision, { nextPrompt, replaceRef });
      const unfilled = (decision.action === 'reprompt' && (!decision.nextPrompt || decision.nextPrompt === STEER_PLACEHOLDER))
        || (decision.action === 'replace_ref' && (!decision.replaceRef || decision.replaceRef === REPLACE_PLACEHOLDER));
      let estimateResult = null;
      if (!unfilled) {
        try {
          estimateResult = await estimate({
            decision,
            shot: { id: request.shotId, kind: 'still' },
            regenJobsUsed,
            stillCount,
            policy: caps,
            iteration,
          });
        } catch (error) {
          failClosed(seed, error?.message ?? 'regen estimate failed', verdicts);
          return;
        }
      }
      const blocked = unfilled || !estimateResult || estimateResult.blocked === true;
      const emitEstimate = (forcedBlocked = false) => {
        if (!estimateResult) return;
        emit({
          type: 'ref_regen_estimate',
          jobId: seed.jobId,
          keyframeSha256: seed.keyframeSha256,
          state: 'regenerating',
          estimate: {
            label: estimateResult.label,
            units: estimateResult.units,
            blocked: estimateResult.blocked === true || forcedBlocked,
            reason: estimateResult.reason,
          },
        });
      };
      if (blocked) {
        decision = {
          ...decision,
          action: 'escalate',
          reason: estimateResult?.reason || (unfilled ? 'steering did not fill the regen' : 'regen estimate blocked'),
        };
      } else {
        const hold = holdUnits(estimateResult);
        if (hold === null || !budgetFits(hold)) {
          decision = {
            ...decision,
            action: 'escalate',
            reason: 'regen estimate exceeds the budget ledger cap',
          };
        } else {
          try {
            budgetLedger.reserve({
              reservationId: `ref-regen:${seed.jobId}:${record.attempt}`,
              upperBound: hold,
              collectAndStopReserve: 0,
              idempotencyKey: `ref-regen-hold:${productionId ?? 'production'}:${seed.jobId}:${record.attempt}`,
              evidence: {
                reason: 'ref_regen',
                label: estimateResult.label,
                jobId: seed.jobId,
                keyframeSha256: seed.keyframeSha256,
                attempt: record.attempt,
              },
            });
          } catch (error) {
            decision = {
              ...decision,
              action: 'escalate',
              reason: error?.code === 'BUDGET_EXCEEDED' ? 'regen estimate exceeds the budget ledger cap' : 'budget ledger refused the regen reservation',
            };
          }
        }
      }

      if (decision.action === 'reprompt' || decision.action === 'replace_ref') {
        const seedValue = freshSeed(previous.seed ?? previous.params?.seed, record.attempt);
        const regen = structuredClone(previous);
        regen.seed = seedValue;
        if (!isObject(regen.params)) regen.params = {};
        regen.params.seed = seedValue;
        if (decision.action === 'reprompt' && decision.nextPrompt) {
          regen.prompt = decision.nextPrompt;
          regen.params.prompt = decision.nextPrompt;
        }
        if (decision.action === 'replace_ref') applyReplaceRef(regen, decision.replaceRef);
        // The Google Colab runner caches by cacheKey, and that key includes the seed. A new seed
        // with the old key would replay the rejected still.
        regen.cacheKey = cacheKeyFor({
          workflowSha256: regen.workflowSha256,
          generator: regen.generator,
          model: regen.model,
          modelRevision: regen.modelRevision,
          params: regen.params,
          seed: seedValue,
          width: regen.dims?.width,
          height: regen.dims?.height,
          frames: regen.frames,
        });
        regen.refRegen = { attempt: record.attempt + 1, seed: seedValue };
        live.set(seed.jobId, regen);
        record.attempt += 1;
        record.state = 'regenerating';
        regenJobsUsed += 1;
        persist(seed.keyframeSha256, verdicts, decision);
        emit({
          type: 'ref_review_verdict',
          jobId: seed.jobId,
          keyframeSha256: seed.keyframeSha256,
          state: 'regenerating',
          verdict,
          decision,
        });
        emitEstimate();
        await submitJobs({ batch: 'regen', jobs: [structuredClone(regen)] });
        emit({
          type: 'ref_regen_queued',
          jobId: seed.jobId,
          keyframeSha256: seed.keyframeSha256,
          state: 'regenerating',
        });
        return;
      }
      emitEstimate(true);
    }

    if (decision.action === 'accept' || decision.action === 'override') {
      record.state = decision.action === 'override' ? 'overridden' : 'accepted';
      acceptedSha.set(seed.jobId, seed.keyframeSha256);
      rememberAccepted(job, seed, verdict);
      persist(seed.keyframeSha256, verdicts, decision);
      emit({
        type: 'ref_review_verdict',
        jobId: seed.jobId,
        keyframeSha256: seed.keyframeSha256,
        state: record.state,
        verdict,
        decision,
      });
      emit({
        type: 'ref_gate_open',
        jobId: seed.jobId,
        keyframeSha256: seed.keyframeSha256,
        state: record.state,
      });
      await maybeReleaseVideos();
      return;
    }

    holdDecision(seed, decision, verdicts);
  }

  async function callReviewer(request, image) {
    if (typeof reviewer !== 'function') {
      throw Object.assign(new Error('reviewer unavailable'), { code: 'REVIEWER_MISSING' });
    }
    const timeoutMs = Number.isFinite(reviewTimeoutMs) && reviewTimeoutMs > 0 ? reviewTimeoutMs : 60_000;
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(Object.assign(new Error('reviewer timed out'), { code: 'REVIEW_TIMEOUT' }));
      }, timeoutMs);
    });
    try {
      return await Promise.race([Promise.resolve(reviewer({ request, image })), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  const watcher = createRefWatcher({
    jobsDoc,
    enqueue: async (seed) => { pending.push(seed); },
    onEvent: (event) => emit(event),
    now,
  });
  const pending = [];

  async function handleUnlocked(event) {
    pending.length = 0;
    await watcher.handle(event);
    const seeds = pending.splice(0);
    for (const seed of seeds) {
      try {
        await reviewSeed(seed);
      } catch (error) {
        failClosed(seed, error?.message ?? 'review failed');
      }
    }
  }

  function handle(event) {
    const run = chain.then(() => handleUnlocked(event));
    chain = run.then(() => {}, () => {});
    return run;
  }

  async function start() {
    if (started) return snapshot();
    started = true;
    const stillBatch = stillJobs.map((job) => structuredClone(live.get(job.id)));
    const passthrough = jobs.filter((job) => !isStill(job) && !isGatedVideo(job)).map((job) => structuredClone(job));
    if (stillBatch.length > 0) await submitJobs({ batch: 'stills', jobs: stillBatch });
    if (passthrough.length > 0) await submitJobs({ batch: 'passthrough', jobs: passthrough });
    return snapshot();
  }

  function filterBatch(list) {
    if (!Array.isArray(list)) return [];
    return list.filter((job) => !isGatedVideo(job) || (
      !submittedVideos.has(job.id)
      && !refusedVideos.has(job.id)
      && keyframeDeps(job).every((id) => refGateOpen(states.get(id)?.state))
      && keyframeDeps(job).every((id) => !stalenessRefusal(job, id))
    ));
  }

  function beforeRender() {
    const held = [];
    for (const [jobId, record] of states) {
      if (record.state === 'pending' || record.state === 'reviewing' || record.state === 'regenerating') held.push(jobId);
    }
    if (held.length > 0) {
      return {
        ok: false,
        held,
        message: 'Reference watch is holding the Google Colab video render until keyframes finish review.',
      };
    }
    return { ok: true, held: [] };
  }

  function snapshot() {
    return {
      regenJobsUsed,
      cap: refRegenJobCap(stillCount, caps),
      states: Object.fromEntries([...states].map(([id, value]) => [id, { ...value }])),
    };
  }

  function stop() {
    watcher.stop();
  }

  return { start, handle, stop, filterBatch, beforeRender, snapshot };
}
