import type { MotionModel } from './super-easy/setup.ts';
import type { VideoType } from './super-easy/video-types.ts';

export type StepId = 'idea' | 'characters' | 'level' | 'plan' | 'generate' | 'review' | 'export';
export type Level = 'draft' | 'balanced' | 'director' | 'custom';
export type Compute = 'cpu' | 'colab';
export type Look = 'clay' | 'glass' | 'editorial-flat' | 'isometric-tech' | 'paper-cut' | 'cinematic-dark';

export interface EasyIdea { text: string; lengthS: number; aspect: '16:9' | '9:16' | '1:1'; look: Look; sound: boolean }
/** Optional song range, in seconds. */
export interface SongTrim { startSeconds: number; endSeconds: number }
export type LyricsStyle = 'off' | 'caption' | 'reel';
export interface EasyQuestion { id: string; field: string; prompt: string; options: string[]; decide: string }
export interface EasyCastMember { castId: string; characterId: string; name: string; role: string; voiceId: string | null; voiceLabel: string | null; imageUrl: string | null }

export interface EasyState {
  version: 1;
  packageId: string | null;
  chatId: string | null;
  productionId: string | null;
  offline: boolean;
  idea: EasyIdea;
  questions: EasyQuestion[];
  questionsAsked: boolean;
  answers: Record<string, string>;
  cast: EasyCastMember[];
  narration: { on: boolean; voiceId: string | null };
  level: Level;
  levelTouched: boolean;
  compute: Compute;
  motionModel?: MotionModel;
  /** Null is Custom, the backward-compatible prompt-only planning path. */
  videoType: VideoType | null;
  /** Null lets the Music Video planner use song start 0 and the requested duration. */
  songTrim: SongTrim | null;
  /** Music Video lyric presentation; raw LRC stays separate from the creative brief. */
  lyricsStyle: LyricsStyle;
  lyricsLrc: string;
  /** Server-owned context identity and a small content signature, never media/text. */
  attachmentSignature: string | null;
  attachmentRevision: number;
  spendCap: number | null;
  planHash: string | null;
  /** Exact inputs used for the last successfully adopted package; legacy states leave this null. */
  builtPackageInputsHash: string | null;
  /** Review checkpoint only; restoring it never restores approval or spend authority. */
  proposalCheckpoint?: { packageId: string; revision: number; inputsHash: string; basePrompt: string; revisionNotes: string[]; deepSeekNoThinking: boolean } | null;
  plan: { status: 'none' | 'writing' | 'building' | 'proposing' | 'ready' | 'stale' | 'error'; error: string | null; errorAt: 'agent' | 'production' | 'proposal' | null; wordsChanged: boolean };
  generate: { status: 'idle' | 'running' | 'stopping' | 'done' | 'stopped' | 'error' };
  review: { shotId: string | null };
  exported: { revision: number | null; at: string | null };
}

export interface StepFacts { hasPackage: boolean; planApproved: boolean; actionsActive: boolean; allShotsKept: boolean; exportCurrent: boolean }

export interface EasyStepContext {
  state: EasyState;
  store: { get(): EasyState; patch(p: Partial<EasyState>): void };
  api: ReturnType<typeof import('./api.ts').createEasyApi>;
  host: EasyHost;
  shell: { setPrimary(o: { label: string; disabled?: boolean; reason?: string | null }): void; setStatus(t: string): void; alert(t: string): void; setBanner(html: string): void };
  go(step: StepId): void;
  rerender(): void;
  dialogs: { quickCharacter?: (o: { opener: HTMLElement }) => Promise<EasyCastMember | null> };
  il?: { mountLevelPicker?: Function; openCompare?: (shotId: string) => void };
  writePlan?: () => Promise<void>;
  approveAndGenerate?: () => Promise<void>;
  retryShot?: (shotId: string, chip?: string) => Promise<void>;
  openAsk?: (prefill?: string) => void;
}

export interface EasyStepModule {
  id: StepId;
  heading: string;
  intro: string;
  primaryLabel(state: EasyState): string;
  render(state: EasyState, facts: StepFacts): string;
  bind(el: HTMLElement, ctx: EasyStepContext): () => void;
  onPrimary(ctx: EasyStepContext): Promise<void> | void;
}

export interface EasyHost {
  apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  hasToken(): boolean;
  editorStore: import('../editor/store.ts').EditorStore;
  getPackage(): any;
  clips(): readonly import('../takes/api.ts').ClipSummary[];
  subscribeClips(listener: () => void): () => void;
  takesApi: Pick<import('../takes/api.ts').TakesApi, 'getTakes' | 'select' | 'verdict'>
    & Partial<Pick<import('../takes/api.ts').TakesApi, 'listClips'>>;
  adoptBuiltPackage(body: any): void;
  /** A production-owned package needs its production id to render. */
  renderMp4(options?: { productionId?: string | null; persistedRevision?: number }): Promise<{ blob: Blob; revision: number; renderId?: string }>;
  seekToScene(sceneId: string): void;
  previewTake(clipId: string, takeId: string | null): Promise<void>;
  refreshClips(): Promise<void>;
  clipGate(): { ok: boolean; approved: number; total: number; blocking: Array<{ clipId: string; state: string }> };
  applySceneChip(sceneId: string, chip: string): Promise<void>;
  aiSelection(): Promise<{ provider: string; model?: string }>;
  openAgentSettings(): void;
  openEditor(): void;
  playerElement(): HTMLElement;
}
