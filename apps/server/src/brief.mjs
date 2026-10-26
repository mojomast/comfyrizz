/**
 * R2 (research §2.3–2.4): server-side plan-mode brief flow.
 *
 * Wraps the deterministic extractor in `@comfyrizz/agent` so the web UI can ask
 * for a brief + at most three chip questions, then apply the answers. Step 4 adds
 * the script-first outline (`buildOutline`) so the Brief card can show and edit
 * the narration beats and their estimated seconds. No model, no network, no GPU:
 * this is pure text work.
 */
import {
  applyDecisions,
  brandBriefStyle,
  buildOutline,
  completeBrief,
  draftKeyMessages,
  extractBrief,
  missingQuestions,
  stylePresets,
} from '../../../packages/agent/dist/src/index.js';
import {
  buildClaimLedger,
  claimResolutionOptions,
  researchContext,
  serverConsent,
  validatedClaims,
} from '../../../packages/agent/dist/src/evidence.js';

export const MAX_QUESTIONS = 3;

/** R2 step 5: the six look cards (CPU/SVG thumbnails) for the brief picker. */
export function briefPresets() {
  return { presets: stylePresets() };
}

function normalizeMode(mode) {
  return mode === 'express' ? 'express' : 'plan';
}

function asEvidenceObject(input) {
  return input?.evidence && typeof input.evidence === 'object' ? input.evidence : {};
}

/**
 * UX18: validate claims only against supplied excerpts and include only claims
 * the server has separately consented to. Claim-level `approved`/`consent`
 * fields are never read; research stays an untrusted data block.
 */
function evidenceFor(input) {
  const nested = asEvidenceObject(input);
  const excerpts = Array.isArray(input.excerpts) ? input.excerpts : Array.isArray(nested.excerpts) ? nested.excerpts : [];
  const claims = Array.isArray(input.claims) ? input.claims : Array.isArray(nested.claims) ? nested.claims : [];
  if (excerpts.length === 0 && claims.length === 0) return null;

  const ledger = buildClaimLedger(claims, excerpts);
  const consent = serverConsent(input.consent ?? nested.consent);
  const granted = new Set(consent.filter(record => record.status === 'granted').map(record => record.claimId));
  const facts = validatedClaims(ledger)
    .filter(entry => granted.has(entry.id))
    .map(entry => ({
      claim: entry.excerpt ?? entry.claim,
      source: entry.source ?? entry.sourceId ?? 'supplied source',
      ...(entry.excerpt ? { excerpt: entry.excerpt } : {}),
      ...(entry.date ? { date: entry.date } : {}),
      ...(entry.qualification ? { qualification: entry.qualification } : {}),
    }));

  return {
    claims: ledger,
    consent,
    facts,
    research: researchContext(excerpts),
    options: ledger.map(entry => ({
      claimId: entry.id,
      status: entry.status,
      options: claimResolutionOptions(entry),
    })),
  };
}

function withEvidence(draft, evidence) {
  if (!evidence) return draft;
  return { ...draft, facts: evidence.facts };
}

function attachEvidence(result, evidence) {
  return evidence ? { ...result, evidence } : result;
}

/** B1: a normalised brand kit overrides the brief's palette and font. */
function styleFor(draft, brand) {
  return brand ? brandBriefStyle(draft.style ?? {}, brand) : undefined;
}

/** Complete a draft and attach its outline. */
function finished(mode, draft, brand, evidence) {
  const brief = completeBrief(withEvidence(draft, evidence), styleFor(draft, brand));
  return attachEvidence(
    { mode, complete: true, questions: [], brief, outline: buildOutline(brief), presets: stylePresets() },
    evidence,
  );
}

/**
 * @param {{
 *   prompt?: string,
 *   mode?: 'plan'|'express',
 *   attachments?: string,
 *   decisions?: Record<string, string|number|undefined>,
 *   askMore?: boolean,
 * }} input
 */
export function planBrief(input = {}) {
  const mode = normalizeMode(input.mode);
  const brand = input.brand ?? null;
  const prompt = typeof input.prompt === 'string' ? input.prompt : '';
  const evidence = evidenceFor(input);
  const draft = extractBrief(prompt, { mode, attachments: input.attachments });
  const options = draftKeyMessages(prompt);

  if (input.decisions && typeof input.decisions === 'object') {
    const answered = applyDecisions(draft, input.decisions);
    const remaining = missingQuestions(answered, MAX_QUESTIONS, options);
    // One round of at most three questions (research §2.4): once the user has
    // answered them, the agent decides anything still open.
    if (input.askMore !== true || remaining.length === 0 || mode === 'express') {
      return finished(mode, answered, brand, evidence);
    }
    return attachEvidence(
      { mode, complete: false, questions: remaining, brief: answered, presets: stylePresets() },
      evidence,
    );
  }

  if (mode === 'express') {
    return finished(mode, draft, brand, evidence);
  }

  const questions = missingQuestions(draft, MAX_QUESTIONS, options);
  if (questions.length === 0) {
    return finished(mode, draft, brand, evidence);
  }
  return attachEvidence(
    { mode, complete: false, questions, brief: draft, presets: stylePresets() },
    evidence,
  );
}

/**
 * Refresh an edited brief: complete it (filling any cleared field with its
 * default) and return the new outline. Step 4's Brief card posts every edit here.
 *
 * @param {{ brief?: object }} input
 */
export function refreshBrief(input = {}) {
  const draft = input.brief && typeof input.brief === 'object' ? input.brief : {};
  const mode = normalizeMode(draft.mode);
  const evidence = evidenceFor(input);
  const brief = completeBrief(withEvidence({ ...draft, mode }, evidence), styleFor(draft, input.brand));
  return attachEvidence(
    { mode, complete: true, questions: [], brief, outline: buildOutline(brief), presets: stylePresets() },
    evidence,
  );
}
