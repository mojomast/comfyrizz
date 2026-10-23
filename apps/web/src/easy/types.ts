export type StepId = 'idea' | 'characters' | 'level' | 'plan' | 'generate' | 'review' | 'export';
export type Level = 'draft' | 'balanced' | 'director' | 'custom';
export type Compute = 'cpu' | 'colab';
export type Look = 'clay' | 'glass' | 'editorial-flat' | 'isometric-tech' | 'paper-cut' | 'cinematic-dark';

export interface EasyIdea { text: string; lengthS: 15 | 30 | 60 | 90; aspect: '16:9' | '9:16' | '1:1'; look: Look; sound: boolean }
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
  spendCap: number;
  planHash: string | null;
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
  adoptBuiltPackage(body: any): void;
  renderMp4(): Promise<{ blob: Blob; revision: number; renderId?: string }>;
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
