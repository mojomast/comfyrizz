// Types for ref-review.mjs (RW00 contracts). Keep in step with the module.
export type RefDimension = 'technical' | 'identity' | 'anatomy' | 'framing' | 'prompt' | 'text_artifact';
export type RefSeverity = 'hard' | 'soft';
export type RefReviewer = 't0' | 'pi' | 'fake';
export type RefOverall = 'pass' | 'fail' | 'error';
export type RefAction = 'accept' | 'reprompt' | 'replace_ref' | 'escalate' | 'override';
export type RefGateState = 'pending' | 'reviewing' | 'accepted' | 'regenerating' | 'held' | 'overridden';
export type RefEvent = 'ref_review_started' | 'ref_review_verdict' | 'ref_review_error' | 'ref_regen_queued' | 'ref_gate_open' | 'ref_gate_held';
export interface RefCharacterLock { characterId: string; identityLock: string; wardrobeState?: string }
export interface RefReviewRequest {
  schema: 'comfyrizz.ref-review.request/v1'; productionId: string; runId: string; jobId: string; shotId: string;
  keyframeSha256: string; imagePath: string; width: number; height: number; plannedWidth: number; plannedHeight: number;
  prompt: string; attempt: number; characters: RefCharacterLock[];
}
export interface RefCheck { dimension: RefDimension; pass: boolean; severity: RefSeverity; evidence: string; category?: string }
export interface RefVerdict {
  schema: 'comfyrizz.ref-review.verdict/v1'; jobId: string; keyframeSha256: string; reviewer: RefReviewer; model?: string;
  overall: RefOverall; checks: RefCheck[]; fixHints: string[];
}
export interface RefDecision {
  schema: 'comfyrizz.ref-review.decision/v1'; jobId: string; keyframeSha256: string; action: RefAction; reason: string; attempt: number;
  nextPrompt?: string; nextSeed?: number; replaceRef?: string; receiptId?: string;
}
export interface RefPolicy { maxRegensPerStill: number; maxRegenJobs: number; maxRegenFraction: number }
export interface ValidationResult { ok: boolean; errors: string[] }
export const REF_REVIEW_REQUEST_SCHEMA: 'comfyrizz.ref-review.request/v1';
export const REF_VERDICT_SCHEMA: 'comfyrizz.ref-review.verdict/v1';
export const REF_DECISION_SCHEMA: 'comfyrizz.ref-review.decision/v1';
export const REF_DIMENSIONS: readonly RefDimension[];
export const REF_SEVERITIES: readonly RefSeverity[];
export const REF_REVIEWERS: readonly RefReviewer[];
export const REF_OVERALL: readonly RefOverall[];
export const REF_ACTIONS: readonly RefAction[];
export const REF_GATE_STATES: readonly RefGateState[];
export const REF_EVENTS: readonly RefEvent[];
export const REF_POLICY_DEFAULTS: Readonly<RefPolicy>;
export function validateRefReviewRequest(r: unknown): ValidationResult;
export function validateRefVerdict(v: unknown): ValidationResult;
export function validateRefDecision(d: unknown): ValidationResult;
export function refRegenJobCap(stillCount: number, policy?: RefPolicy): number;
export function refGateOpen(state: unknown): boolean;
