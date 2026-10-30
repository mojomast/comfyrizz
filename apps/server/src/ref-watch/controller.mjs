// RW08: Reference Watch controller. Stills render first. A video job stays held
// until every keyframe it uses is accepted or overridden. Regen jobs reserve
// the same production budget ledger self-repair spends from, and only after
// the regen estimate. Nothing here calls Google Colab, Comfy, or the network.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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
import { TITLE_CARD_BATCH, titleCardJobs } from '../compositing/title-card.mjs';
import { refuseStaleVideo } from '../productions/keyframe-staleness.mjs';
import { chainDefaultFor, planChainedShot } from './chain.mjs';
import { decide as decideDefault } from './decide.mjs';
import { EDIT_PLACEHOLDER, buildEditInstruction, fillEditDecision } from './edit-plan.mjs';
import { estimateRegen } from './estimate.mjs';
import * as steerDefault from './steer.mjs';
import { runT0Checks } from './t0-checks.mjs';
import { createRefWatcher } from './watcher.mjs';

const VIDEO_KINDS = new Set(['plate', 'upscale', 'presenter']);
const STEER_PLACEHOLDER = '<steer>';
const REPLACE_PLACEHOLDER = '<replace-ref>';
const SECRET = /(api[_-]?key|token|secret|authorization|bearer)\s*[:=]\s*\S+/gi;
const QWEN_EDIT_WORKFLOW = 'workflows/qwen_edit_2511_instruct.api.json';
const QWEN_EDIT_MODEL = 'qwen_image_edit_2511_fp8mixed';
const QWEN_EDIT_STEPS = 40;
const QWEN_EDIT_CFG = 4;
let qwenEditWorkflowSha256 = null;

function qwenEditWorkflowSha() {
  if (qwenEditWorkflowSha256 === null) {
    const file = new URL(`../../../../${QWEN_EDIT_WORKFLOW}`, import.meta.url);
    qwenEditWorkflowSha256 = createHash('sha256').update(readFileSync(file)).digest('hex');
  }
  return qwenEditWorkflowSha256;
}

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
  extractLastFrame,
  reviewKeyframe,
  planChained = planChainedShot,
} = {}) {
  if (!isObject(jobsDoc)) throw new TypeError('createRefWatchController requires a jobsDoc object');
  if (typeof submitJobs !== 'function') throw new TypeError('createRefWatchController requires submitJobs');

  const jobs = (Array.isArray(jobsDoc.jobs) ? jobsDoc.jobs : []).filter(isObject);
  const live = new Map(jobs.map((job) => [job.id, structuredClone(job)]));
  const productionId = jobsDoc.productionId ?? jobsDoc.packageId ?? null;
  const runId = typeof jobsDoc.runId === 'string' && jobsDoc.runId ? jobsDoc.runId : 'run';
  const caps = { ...REF_POLICY_DEFAULTS, ...(policy ?? {}) };
  const stillJobs = jobs.filter(isStill);
  const titleCards = Array.isArray(jobsDoc.titleCards) ? jobsDoc.titleCards.filter(isObject) : [];
  const stillIds = new Set(stillJobs.map((job) => job.id));
  const stillCount = stillJobs.length;
  const steerPrompt = steer?.steerPrompt ?? steerDefault.steerPrompt;
  const fillDecision = steer?.fillDecision ?? steerDefault.fillDecision;
  const chooseReplacementRef = steer?.chooseReplacementRef ?? steerDefault.chooseReplacementRef;

  const states = new Map();
  const acceptedSha = new Map();
  const acceptedStills = [];
  const submittedVideos = new Set();
  const queuedTitleCutouts = new Set();
  const refusedVideos = new Set();
  const deferredVideos = new Set();
  let regenJobsUsed = 0;
  let started = false;
  let chain = Promise.resolve();

  for (const job of stillJobs) {
    states.set(job.id, { state: 'pending', attempt: 0, identityFailures: 0, editsTried: 0 });
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
    if (!states.has(jobId)) states.set(jobId, { state: 'pending', attempt: 0, identityFailures: 0, editsTried: 0 });
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

  function isLtxI2v(job) {
    if (!isVideo(job) || job.generator !== 'ltx25') return false;
    if (typeof job.workflow === 'string' && job.workflow !== '' && !/ltx25_i2v/.test(job.workflow)) return false;
    return keyframeDeps(job).length > 0;
  }

  function previousLtxVideo(video) {
    const list = gatedVideos.filter(isLtxI2v);
    const index = list.findIndex((job) => job.id === video.id);
    return index > 0 ? list[index - 1] : null;
  }

  async function chainPlanFor(video, previousOverride) {
    if (!isLtxI2v(video) || !isObject(video.shot)) return null;
    const previous = previousOverride === undefined ? previousLtxVideo(video) : previousOverride;
    const chainFromPrevious = chainDefaultFor({
      shot: video.shot,
      previousShot: isObject(previous?.shot) ? previous.shot : null,
      override: video.chainFromPreviousOverride,
    });
    video.chainFromPrevious = chainFromPrevious;
    if (!chainFromPrevious || !previous) return null;
    if (typeof extractLastFrame !== 'function' || typeof reviewKeyframe !== 'function') {
      video.chainFallback = 'keyframe';
      video.chainFallbackReason = 'chained frame review is not wired';
      return null;
    }
    try {
      const plan = await planChained({
        previousClip: previous,
        chainFromPrevious: true,
        characters: charactersFor(video),
        extractLastFrame,
        reviewKeyframe,
      });
      if (plan?.fallback === 'keyframe') {
        video.chainFallback = 'keyframe';
        video.chainFallbackReason = plan.reason ?? 'identity check failed';
        return null;
      }
      return plan;
    } catch (error) {
      video.chainFallback = 'keyframe';
      video.chainFallbackReason = redact(error?.message ?? 'chain plan failed');
      return null;
    }
  }

  function emitChainPlanned(video, chained, fallback, reason) {
    emit({
      type: 'ref_chain_planned',
      jobId: video.id,
      chained,
      fallback: fallback ?? null,
      reason: typeof reason === 'string' && reason
        ? reason
        : (chained ? 'chained from the previous clip' : 'chaining is off for this shot'),
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
        deferredVideos.delete(video.id);
        emit({
          type: 'ref_gate_held',
          jobId: video.id,
          keyframeSha256: refusal.keyframeSha256,
          state: 'held',
          refusal,
        });
        continue;
      }
      const next = structuredClone(live.get(video.id) ?? video);
      if (isLtxI2v(video)) {
        const previous = previousLtxVideo(video);
        const chained = chainDefaultFor({
          shot: video.shot,
          previousShot: isObject(previous?.shot) ? previous.shot : null,
          override: video.chainFromPreviousOverride,
        });
        next.chainFromPrevious = chained;
        if (chained) {
          const previousLive = isObject(previous) ? (live.get(previous.id) ?? previous) : null;
          if (previousLive && previousLive.status !== 'accepted') {
            deferredVideos.add(video.id);
            continue;
          }
          if (!previousLive) {
            next.chainFallback = 'keyframe';
            next.chainFallbackReason = 'chained shot has no previous clip';
            emitChainPlanned(video, true, 'keyframe', next.chainFallbackReason);
          } else {
            const chainPlan = await chainPlanFor(next, previousLive);
            if (chainPlan?.loadImage) {
              next.loadImage = chainPlan.loadImage;
              next.imgToVideoInplace = chainPlan.imgToVideoInplace;
            }
            emitChainPlanned(
              video,
              true,
              next.chainFallback ?? null,
              next.chainFallbackReason ?? (chainPlan?.loadImage ? 'chained from the previous clip' : 'chained frame unavailable'),
            );
            deferredVideos.delete(video.id);
            submittedVideos.add(video.id);
            await submitJobs({ batch: 'video', jobs: [next] });
            continue;
          }
        } else {
          emitChainPlanned(video, false, null, 'chaining is off for this shot');
        }
      }
      deferredVideos.delete(video.id);
      ready.push(next);
      submittedVideos.add(video.id);
    }
    if (ready.length > 0) await submitJobs({ batch: 'video', jobs: ready });
  }

  async function queueTitleCutouts(jobId) {
    if (queuedTitleCutouts.has(jobId)) return;
    const titles = titleCards.filter((title) => title.stillJobId === jobId);
    if (titles.length === 0) return;
    if (!refGateOpen(states.get(jobId)?.state)) return;
    const { jobs: cutouts } = titleCardJobs({
      jobsDoc: { ...jobsDoc, jobs: [...live.values()] },
      acceptedStills,
      titles,
    });
    if (cutouts.length === 0) return;
    queuedTitleCutouts.add(jobId);
    await submitJobs({ batch: TITLE_CARD_BATCH, jobs: cutouts });
    for (const cutout of cutouts) {
      emit({
        type: 'ref_title_cutout_queued',
        jobId,
        cutoutJobId: cutout.id,
      });
    }
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

  function buildQwenEditJob(previous, seed, decision, attempt) {
    const seedValue = freshSeed(previous.seed ?? previous.params?.seed, attempt);
    const edit = structuredClone(previous);
    edit.kind = 'still';
    edit.batch = 'stills';
    edit.outputKind = 'image';
    edit.output = previous.output ?? seed.imagePath;
    edit.generator = 'qwen-edit-2511';
    edit.workflow = QWEN_EDIT_WORKFLOW;
    edit.workflowSha256 = qwenEditWorkflowSha();
    edit.model = QWEN_EDIT_MODEL;
    edit.modelRevision = null;
    edit.seed = seedValue;
    edit.prompt = previous.prompt ?? previous.params?.prompt ?? '';
    edit.params = {
      image: seed.imagePath,
      instruction: decision.editInstruction,
      seed: seedValue,
      steps: QWEN_EDIT_STEPS,
      cfg: QWEN_EDIT_CFG,
    };
    edit.fileInputs = [{ param: 'image', from: 'package', path: seed.imagePath }];
    edit.refEdit = {
      attempt: attempt + 1,
      dimension: decision.editDimension,
      instruction: decision.editInstruction,
    };
    edit.cacheKey = cacheKeyFor({
      workflowSha256: edit.workflowSha256,
      generator: edit.generator,
      model: edit.model,
      modelRevision: edit.modelRevision,
      params: edit.params,
      seed: seedValue,
      width: edit.dims?.width,
      height: edit.dims?.height,
      frames: edit.frames,
    });
    return edit;
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
      editsTried: record.editsTried,
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

    const regenAction = decision.action === 'reprompt'
      || decision.action === 'replace_ref'
      || decision.action === 'targeted_edit';
    if (regenAction) {
      const previous = live.get(seed.jobId);
      const targetedEdit = decision.action === 'targeted_edit';
      let nextPrompt;
      let replaceRef;
      if (decision.action === 'reprompt') {
        nextPrompt = steerPrompt({
          previousPrompt: previous.params?.prompt ?? previous.prompt ?? '',
          verdict,
          characters,
        });
      }
      if (decision.action === 'replace_ref') {
        replaceRef = chooseReplacementRef({
          characterId: characters[0]?.characterId,
          primaryImage: previous.primaryImage ?? previous.params?.reference,
          acceptedStills,
        });
      }
      if (targetedEdit) {
        decision = fillEditDecision(decision, {
          editInstruction: buildEditInstruction({ verdict, characters }),
        });
      } else {
        decision = fillDecision(decision, { nextPrompt, replaceRef });
      }
      const unfilled = targetedEdit
        ? (!decision.editInstruction || decision.editInstruction === EDIT_PLACEHOLDER)
        : (decision.action === 'reprompt' && (!decision.nextPrompt || decision.nextPrompt === STEER_PLACEHOLDER))
          || (decision.action === 'replace_ref' && (!decision.replaceRef || decision.replaceRef === REPLACE_PLACEHOLDER));
      let estimateResult = null;
      if (!unfilled) {
        try {
          estimateResult = await estimate({
            decision: targetedEdit ? { ...decision, action: 'reprompt' } : decision,
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
          reason: estimateResult?.reason || (unfilled
            ? (targetedEdit ? 'the targeted edit instruction was empty' : 'steering did not fill the regen')
            : 'regen estimate blocked'),
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
                reason: targetedEdit ? 'ref_targeted_edit' : 'ref_regen',
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

      if (decision.action === 'targeted_edit') {
        const edit = buildQwenEditJob(previous, seed, decision, record.attempt);
        live.set(seed.jobId, edit);
        record.attempt += 1;
        record.editsTried = (Number.isSafeInteger(record.editsTried) ? record.editsTried : 0) + 1;
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
        await submitJobs({ batch: 'regen', jobs: [structuredClone(edit)] });
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
      await queueTitleCutouts(seed.jobId);
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
    if (isObject(event) && event.type === 'video_collected') {
      const collected = typeof event.jobId === 'string' ? live.get(event.jobId) : null;
      if (collected) {
        collected.status = 'accepted';
        if (typeof event.path === 'string' && event.path) collected.localPath = event.path;
        await maybeReleaseVideos();
      }
      return;
    }
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
      && !deferredVideos.has(job.id)
      && keyframeDeps(job).every((id) => refGateOpen(states.get(id)?.state))
      && keyframeDeps(job).every((id) => !stalenessRefusal(job, id))
    ));
  }

  function beforeRender() {
    const held = [];
    for (const [jobId, record] of states) {
      if (record.state === 'pending' || record.state === 'reviewing' || record.state === 'regenerating') held.push(jobId);
    }
    for (const jobId of deferredVideos) {
      if (!held.includes(jobId)) held.push(jobId);
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
