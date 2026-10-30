// SE07: mount the Super Easy shell.
//
// The router decides that a bare visit belongs to Super Easy; this module
// paints the one-prompt home or the progress view for a run that is already
// under way. It is presentation and navigation only: no network, no player
// adoption and no generation logic. The studio handoff belongs to the Easy
// mount so there is one owner of the borrowed player.

import { COPY } from './copy.ts';
import {
  escapeToEditor,
  escapeToHome,
  escapeToStudio,
  makeAnotherState,
} from './escape.ts';
import {
  SUPER_EASY_IDEAS,
  SUPER_EASY_MIN_PROMPT_CHARS,
  renderSuperEasyHome,
} from './home.ts';
import {
  superEasyProgressParts,
  updateSuperEasyProgress,
  type ProgressRoot,
  type SuperEasyProgressFailure,
  type SuperEasyProgressKeys,
  type SuperEasyProgressViewOptions,
} from './progress-view.ts';
import type { StagesProgress } from './stages.ts';
import type { GalleryModel } from './gallery-model.ts';
import { DEFAULT_SUPER_EASY_SETUP, type SuperEasySetup, type MotionModel } from './setup.ts';
import { renderSuperEasyProposal, type SuperEasyProposal } from './proposal.ts';
import { getMode, setMode } from '../../ui/mode.ts';
import type { EasyState, LyricsStyle, SongTrim } from '../types.ts';
import { isEasyDuration } from '../duration.ts';
import { formatSuperEasyLrcErrors, validateSuperEasyLrc } from './lyrics.ts';
import { mountAgentConsole } from '../agent-console.ts';
import { isVideoType, videoTypeMetadata, type VideoType } from './video-types.ts';
import { createSongPreview, songPreviewMaster } from './song-preview.ts';
import {
  renderContextAttachmentItems,
  renderContextAttachmentStatus,
  type SuperEasyContextAttachments,
} from './context-attachments.ts';

export const SUPER_EASY_EXAMPLE_PROMPT = COPY.home.promptPlaceholder;

export type SuperEasyScreen = 'home' | 'progress';

export interface SuperEasyGenerateInput {
  prompt: string;
  compute: EasyState['compute'];
  lengthS?: EasyState['idea']['lengthS'];
  setupConfirmed?: boolean;
  motionModel?: MotionModel;
  deepSeekNoThinking?: boolean;
  videoType?: VideoType;
  songTrim?: SongTrim | null;
  lyricsStyle?: LyricsStyle;
  lyricsLrc?: string;
  conversationId?: string;
  attachmentSignature?: string;
  attachmentRevision?: number;
  /** "Record this run" was ticked; the Generate click is the gesture that starts it. */
  capture?: boolean;
}

export interface SuperEasyMountOptions {
  root: HTMLElement;
  state(): EasyState;
  /** Re-render when the shared Easy store changes. */
  subscribe?(listener: () => void): () => void;
  /** Latest production snapshot for the progress view. */
  snapshot?(): unknown;
  /** Current address, so escape links keep the package id. Defaults to the browser. */
  search?(): string;
  /** Replace the address without navigating away. Defaults to browser history. */
  navigate?(url: string): void;
  /** Leave Super Easy for the existing Easy Studio. */
  onMoreControl(packageId: string | null): void;
  /** Open the Advanced editor for this video. */
  onOpenEditor?(packageId: string | null): void;
  /** Clear local state for a new video; the server package is kept. */
  onMakeAnother?(next: EasyState): void;
  /** SE09 owns the run; the shell only hands it the one prompt. */
  onGenerate?(input: SuperEasyGenerateInput): void | Promise<void>;
  /** A playable preview exists and the finished MP4 is still being watched. */
  previewReady?(): boolean;
  /** The run stopped before a preview; the message stays on this screen. */
  failure?(): SuperEasyProgressFailure | null;
  /** Re-run the last prompt after a visible failure. */
  onRetry?(): void;
  onRecoverDownloadedOutputs?(): void;
  onReviseNarration?(): void;
  /** Review the playable preview, then export from Studio. */
  onReview?(packageId: string | null): void;
  /** Make the MP4 from the playable preview. Falls back to Review. */
  onExport?(packageId: string | null): void;
  /** Gauges and real collected media, when the caller knows more than the journal does. */
  stages?(snapshot: unknown): StagesProgress | undefined;
  gallery?(snapshot: unknown): GalleryModel | undefined;
  reducedMotion?: boolean;
  /** Offer "Record this run" on the home; returns whether it starts ticked. */
  captureArmed?(): boolean;
  onCaptureToggle?(armed: boolean): void;
  /** Credential-free saved backend/cap preference and its one-time setup action. */
  setup?(): SuperEasySetup;
  onSetup?(): void;
  onMotionModelChange?(model: MotionModel): void;
  /** Keep the duration in the shared Easy idea, not a Super Easy-only preference. */
  onLengthChange?(lengthS: EasyState['idea']['lengthS']): void;
  onAspectChange?(aspect: EasyState['idea']['aspect']): void;
  /** Native type cards update shared state without rebuilding the prompt. */
  onVideoTypeChange?(videoType: VideoType | null): void;
  /** Valid trim edits persist immediately; invalid partial edits only show local help. */
  onSongTrimChange?(songTrim: SongTrim | null): void;
  /** Lyric drafts persist without replacing the prompt or attachment controls. */
  onLyricsStyleChange?(lyricsStyle: LyricsStyle): void;
  onLyricsLrcChange?(lyricsLrc: string): void;
  /** Long-lived, network-owning attachment controller; rendering alone never creates a chat. */
  attachments?: SuperEasyContextAttachments;
  previewFetch?(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  onFontUpload?(file: File): Promise<string>;
  onFontRemove?(): Promise<string>;
  /** Open the current project's agent with an optional requested change. */
  onChangeAnything?(change?: string): void;
  proposal?(): SuperEasyProposal | null;
  onApproveProposal?(): void;
  onReviseProposal?(note: string): void;
  onReviewEditPlan?(packageId: string | null): void;
}

export interface SuperEasyMountHandle {
  render(options?: { forceHome?: boolean }): void;
  /** Refresh only attachment-owned regions, preserving prompt and file focus. */
  syncAttachments(): void;
  screen(): SuperEasyScreen;
  destroy(): void;
}

function closestOf(target: EventTarget | null): (selector: string) => Element | null {
  const candidate = target as { closest?: (selector: string) => Element | null } | null;
  if (candidate && typeof candidate.closest === 'function') {
    return (selector) => candidate.closest?.(selector) ?? null;
  }
  return () => null;
}

function isLength(value: unknown): value is EasyState['idea']['lengthS'] { return isEasyDuration(value); }

export type SuperEasySongTrimParse =
  | { ok: true; value: SongTrim | null }
  | { ok: false };

export function parseSuperEasySongTrim(startValue: string, endValue: string): SuperEasySongTrimParse {
  const startText = startValue.trim();
  const endText = endValue.trim();
  if (startText === '' && endText === '') return { ok: true, value: null };
  if (startText === '' || endText === '') return { ok: false };
  const startSeconds = Number(startText);
  const endSeconds = Number(endText);
  if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || startSeconds < 0 || endSeconds <= startSeconds) {
    return { ok: false };
  }
  return { ok: true, value: { startSeconds, endSeconds } };
}

function sameSongTrim(left: SongTrim | null, right: SongTrim | null): boolean {
  if (left === null || right === null) return left === right;
  return left.startSeconds === right.startSeconds && left.endSeconds === right.endSeconds;
}

/**
 * Home is the bare landing. A production or an active generation means the
 * same view should follow the run instead of asking for the prompt again.
 */
export function superEasyScreen(state: Pick<EasyState, 'productionId' | 'generate'>): SuperEasyScreen {
  if (state.generate.status !== 'idle') return 'progress';
  return state.productionId === null || state.productionId === '' ? 'home' : 'progress';
}

/**
 * Paint Super Easy inside `root` and keep it current until `destroy`.
 *
 * The caller owns the player: this mount never queries for it and never moves
 * it, so there is no second adoption while the studio is parked underneath.
 */
export function mountSuperEasy(options: SuperEasyMountOptions): SuperEasyMountHandle {
  const { root } = options;
  let freshStart = false;
  const screenNow = (): SuperEasyScreen => (freshStart ? 'home' : superEasyScreen(options.state()));
  let current = screenNow();
  let promptText = options.state().idea.text ?? '';
  let deepSeekNoThinking = false;
  let selectedVideoType: VideoType | null = isVideoType(options.state().videoType) ? options.state().videoType : null;
  const initialSongTrim = options.state().songTrim;
  let selectedSongTrim: SongTrim | null = initialSongTrim ? { ...initialSongTrim } : null;
  let selectedLyricsStyle: LyricsStyle = options.state().lyricsStyle ?? 'off';
  let lyricsLrcText = options.state().lyricsLrc ?? '';
  let destroyed = false;
  let fontPending = false;
  let progressKeys: SuperEasyProgressKeys | null = null;
  let stopAgentConsole: (() => void) | null = null;
  let attachmentLoadKey: string | null = null;
  let renderedAttachmentList: HTMLElement | null = null;
  let renderedAttachmentKey: string | null = null;
  let renderedAttachmentRows = new Map<string, string>();
  const dirtyAttachmentNotes = new Map<string, string>();
  const songPreview = options.previewFetch ? createSongPreview({
    root,
    fetch: options.previewFetch,
    master: () => String(selectedVideoType) === 'music-video'
      ? songPreviewMaster(options.attachments?.snapshot().attachments ?? [], options.state().chatId)
      : null,
    requested: () => options.state().idea.lengthS,
    changed: () => { updateSongTrimFromFields(); },
  }) : null;

  function currentSearch(): string {
    if (options.search) return options.search();
    try {
      return globalThis.location?.search ?? '';
    } catch {
      return '';
    }
  }

  function replaceUrl(url: string): void {
    if (options.navigate) {
      options.navigate(url);
      return;
    }
    try {
      const history = globalThis.history;
      if (history && typeof history.replaceState === 'function') {
        history.replaceState({}, '', url === '' ? './' : url);
      }
    } catch {
      /* history is absent in tests and some embedded shells */
    }
  }

  function openEditor(): void {
    const packageId = options.state().packageId;
    if (options.onOpenEditor) {
      options.onOpenEditor(packageId);
      return;
    }
    replaceUrl(escapeToEditor(currentSearch(), packageId));
    if (getMode() !== 'advanced') setMode('advanced');
  }

  function makeAnother(): void {
    freshStart = true;
    promptText = '';
    deepSeekNoThinking = false;
    selectedVideoType = null;
    selectedSongTrim = null;
    selectedLyricsStyle = 'off';
    lyricsLrcText = '';
    attachmentLoadKey = null;
    dirtyAttachmentNotes.clear();
    options.attachments?.reset();
    const next = makeAnotherState();
    options.onMakeAnother?.(next);
    replaceUrl(escapeToHome(currentSearch()));
    render({ forceHome: true });
  }

  const onClick = (event: Event): void => {
    const closest = closestOf(event.target);
    if (closest('[data-super-easy-font-remove]')) {
      event.preventDefault();
      const status = root.querySelector<HTMLElement>('[data-super-easy-font-status]');
      if (!status || !options.onFontRemove || fontPending) return;
      fontPending = true;
      status.textContent = 'Removing font…';
      void options.onFontRemove().then(message => { status.textContent = message; }).catch(error => { status.textContent = error instanceof Error ? error.message : 'Font removal failed.'; }).finally(() => { fontPending = false; });
      return;
    }
    if (closest('[data-super-easy-context-add-url]')) {
      event.preventDefault();
      const field = root.querySelector<HTMLInputElement>('[data-super-easy-context-url]');
      const value = field?.value ?? '';
      void options.attachments?.addUrl(value).then(added => {
        if (added && field) field.value = '';
      });
      return;
    }
    const remove = closest('[data-super-easy-context-remove]');
    if (remove) {
      event.preventDefault();
      const id = remove.getAttribute('data-super-easy-context-remove') ?? '';
      const source = remove.getAttribute('data-context-source') === 'media' ? 'media' : 'context';
      void options.attachments?.remove(source, id);
      return;
    }
    const dismiss = closest('[data-super-easy-context-dismiss]');
    if (dismiss) {
      event.preventDefault();
      options.attachments?.dismissPending(dismiss.getAttribute('data-super-easy-context-dismiss') ?? '');
      return;
    }
    if (closest('[data-super-easy-review-edit-plan]')) {
      event.preventDefault();
      options.onReviewEditPlan?.(options.state().packageId);
      return;
    }
    if (closest('[data-super-easy-approve-proposal]')) {
      event.preventDefault();
      options.onApproveProposal?.();
      return;
    }
    const shortenNarration = closest('[data-super-easy-shorten-narration]');
    if (shortenNarration) {
      event.preventDefault();
      const seconds = Number(shortenNarration.getAttribute('data-super-easy-shorten-narration'));
      if (Number.isFinite(seconds) && seconds > 0) options.onReviseProposal?.('Shorten narration to fit comfortably within each shot, allowing for transition overlaps. Preserve the existing duration and the source story.');
      return;
    }
    if (closest('[data-super-easy-setup]')) {
      event.preventDefault();
      options.onSetup?.();
      return;
    }
    if (closest('[data-super-easy-export]')) {
      event.preventDefault();
      const packageId = options.state().packageId;
      if (options.onExport) options.onExport(packageId);
      else if (options.onReview) options.onReview(packageId);
      else options.onMoreControl(packageId);
      return;
    }
    if (closest('[data-super-easy-change]')) {
      event.preventDefault();
      options.onChangeAnything?.();
      return;
    }
    if (closest('[data-super-easy-review]')) {
      event.preventDefault();
      const packageId = options.state().packageId;
      if (options.onReview) options.onReview(packageId);
      else options.onMoreControl(packageId);
      return;
    }
    if (closest('[data-super-easy-revise-narration]')) {
      event.preventDefault();
      options.onReviseNarration?.();
      return;
    }
    if (closest('[data-super-easy-retry]')) {
      event.preventDefault();
      options.onRetry?.();
      return;
    }
    const recover = closest('[data-super-easy-recover-outputs]') as HTMLButtonElement | null;
    if (recover) {
      event.preventDefault();
      if (recover.disabled || !options.failure?.()?.downloadedOutputsRecovery) return;
      recover.disabled = true;
      options.onRecoverDownloadedOutputs?.();
      return;
    }
    if (closest('[data-super-easy-more-control]') || closest('[data-super-easy-open-studio]')) {
      event.preventDefault();
      const packageId = options.state().packageId;
      replaceUrl(escapeToStudio(currentSearch(), packageId));
      options.onMoreControl(packageId);
      return;
    }
    if (closest('[data-super-easy-open-editor]')) {
      event.preventDefault();
      openEditor();
      return;
    }
    if (closest('[data-super-easy-make-another]')) {
      event.preventDefault();
      makeAnother();
      return;
    }
    const idea = closest('[data-super-easy-idea]');
    if (closest('[data-super-easy-example]') || idea) {
      event.preventDefault();
      const id = idea?.getAttribute('data-super-easy-idea') ?? '';
      promptText = SUPER_EASY_IDEAS[id] ?? SUPER_EASY_EXAMPLE_PROMPT;
      showPromptError(false);
      const field = root.querySelector<HTMLTextAreaElement>('#super-easy-prompt');
      if (field) {
        field.value = promptText;
        field.focus();
      }
    }
  };

  function showPromptError(visible: boolean): void {
    const error = root.querySelector<HTMLElement>('[data-super-easy-prompt-error]');
    const field = root.querySelector<HTMLTextAreaElement>('#super-easy-prompt');
    if (error) error.hidden = !visible;
    if (!field || typeof field.setAttribute !== 'function' || typeof field.removeAttribute !== 'function') return;
    if (visible) {
      field.setAttribute('aria-invalid', 'true');
      field.setAttribute('aria-describedby', 'super-easy-prompt-hint super-easy-prompt-error');
    } else {
      field.removeAttribute('aria-invalid');
      field.setAttribute('aria-describedby', 'super-easy-prompt-hint');
    }
  }

  function showSongTrimError(visible: boolean): void {
    const error = root.querySelector<HTMLElement>('[data-super-easy-song-trim-error]');
    if (error) error.hidden = !visible;
    for (const selector of ['[data-super-easy-song-start]', '[data-super-easy-song-end]']) {
      const field = root.querySelector<HTMLInputElement>(selector);
      if (!field || typeof field.setAttribute !== 'function' || typeof field.removeAttribute !== 'function') continue;
      if (visible) field.setAttribute('aria-invalid', 'true');
      else field.removeAttribute('aria-invalid');
    }
  }

  function updateSongTrimFromFields(): boolean {
    const start = root.querySelector<HTMLInputElement>('[data-super-easy-song-start]');
    const end = root.querySelector<HTMLInputElement>('[data-super-easy-song-end]');
    if (!start || !end) return true;
    const parsed = parseSuperEasySongTrim(start.value, end.value);
    showSongTrimError(!parsed.ok);
    if (!parsed.ok) return false;
    if (!sameSongTrim(selectedSongTrim, parsed.value)) {
      selectedSongTrim = parsed.value;
      options.onSongTrimChange?.(selectedSongTrim ? { ...selectedSongTrim } : null);
    }
    return true;
  }

  function syncSongTrim(): void {
    const group = root.querySelector<HTMLElement>('[data-super-easy-song-trim]');
    if (group) group.hidden = String(selectedVideoType) !== 'music-video';
    const duration = String(options.state().idea.lengthS);
    const durationLabel = root.querySelector<HTMLElement>('[data-super-easy-song-trim-duration]');
    if (durationLabel) durationLabel.textContent = duration;
    const end = root.querySelector<HTMLInputElement>('[data-super-easy-song-end]');
    if (end) end.placeholder = duration;
  }

  function syncLyrics(): void {
    const group = root.querySelector<HTMLElement>('[data-super-easy-lyrics]');
    if (group) group.hidden = String(selectedVideoType) !== 'music-video';
    const layout = root.querySelector<HTMLElement>('[data-super-easy-music-layout]');
    if (layout) layout.hidden = false;
  }

  function showLyricsError(message = ''): void {
    const error = root.querySelector<HTMLElement>('[data-super-easy-lyrics-error]');
    const field = root.querySelector<HTMLTextAreaElement>('[data-super-easy-lyrics-lrc]');
    if (error) {
      error.hidden = message === '';
      error.textContent = message;
    }
    if (!field || typeof field.setAttribute !== 'function' || typeof field.removeAttribute !== 'function') return;
    if (message) field.setAttribute('aria-invalid', 'true');
    else field.removeAttribute('aria-invalid');
  }

  function readLyricsFields(): void {
    const style = root.querySelector<HTMLSelectElement>('[data-super-easy-lyrics-style]');
    if (style) selectedLyricsStyle = style.value === 'caption' || style.value === 'reel' ? style.value : 'off';
    const field = root.querySelector<HTMLTextAreaElement>('[data-super-easy-lyrics-lrc]');
    if (field) lyricsLrcText = field.value;
  }

  function includeLyrics(): boolean {
    return String(selectedVideoType) === 'music-video'
      && (selectedLyricsStyle !== 'off' || lyricsLrcText.trim() !== '');
  }

  const onInput = (event: Event): void => {
    const closest = closestOf(event.target);
    if (closest('[data-super-easy-custom-length]')) {
      const field = event.target as HTMLInputElement;
      const selected = root.querySelector<HTMLInputElement>('[data-super-easy-length]:checked');
      if (selected) selected.checked = false;
      const value = field.value.trim() === '' ? NaN : Number(field.value);
      const valid = isLength(value);
      const error = root.querySelector<HTMLElement>('[data-super-easy-length-error]');
      if (error) error.hidden = valid;
      if (valid) {
        field.removeAttribute?.('aria-invalid');
        options.onLengthChange?.(value);
        syncSongTrim();
      } else field.setAttribute?.('aria-invalid', 'true');
      return;
    }
    const note = closest('[data-super-easy-context-note]');
    if (note) {
      const id = note.getAttribute('data-super-easy-context-note') ?? '';
      const key = `media:${id}`;
      const value = (event.target as HTMLInputElement).value ?? '';
      const saved = options.attachments?.snapshot().attachments
        .find(item => item.source === 'media' && item.id === id)?.note ?? '';
      if (value === saved) dirtyAttachmentNotes.delete(key);
      else dirtyAttachmentNotes.set(key, value);
      return;
    }
    if (closest('[data-super-easy-song-start]') || closest('[data-super-easy-song-end]')) {
      updateSongTrimFromFields();
      return;
    }
    if (closest('[data-super-easy-lyrics-lrc]')) {
      const field = event.target as HTMLTextAreaElement;
      lyricsLrcText = field.value ?? '';
      options.onLyricsLrcChange?.(lyricsLrcText);
      showLyricsError();
      return;
    }
    if (!closest('#super-easy-prompt')) return;
    const field = event.target as HTMLTextAreaElement;
    if (typeof field.value === 'string') promptText = field.value;
    showPromptError(false);
  };

  const onSubmit = (event: Event): void => {
    if (closestOf(event.target)('[data-super-easy-revise-proposal]')) {
      event.preventDefault();
      const field = root.querySelector<HTMLTextAreaElement>('#super-easy-proposal-change');
      const note = field?.value.trim() ?? '';
      if (note) options.onReviseProposal?.(note);
      return;
    }
    if (closestOf(event.target)('[data-super-easy-change-form]')) {
      event.preventDefault();
      const field = root.querySelector<HTMLTextAreaElement>('#super-easy-change');
      options.onChangeAnything?.(field?.value.trim() ?? '');
      return;
    }
    if (!closestOf(event.target)('[data-super-easy-form]')) return;
    event.preventDefault();
    if (fontPending) return;
    const field = root.querySelector<HTMLTextAreaElement>('#super-easy-prompt');
    const prompt = (field?.value ?? promptText).trim();
    if (prompt.length < SUPER_EASY_MIN_PROMPT_CHARS) {
      showPromptError(true);
      field?.focus();
      return;
    }
    promptText = prompt;
    if (String(selectedVideoType) === 'music-video' && !updateSongTrimFromFields()) {
      root.querySelector<HTMLInputElement>('[data-super-easy-song-start]')?.focus();
      return;
    }
    if (String(selectedVideoType) === 'music-video') {
      readLyricsFields();
      const validation = validateSuperEasyLrc(lyricsLrcText);
      if (!validation.ok) {
        showLyricsError(formatSuperEasyLrcErrors(validation.errors));
        root.querySelector<HTMLTextAreaElement>('[data-super-easy-lyrics-lrc]')?.focus();
        return;
      }
      showLyricsError();
    }
    const setup = options.setup?.() ?? DEFAULT_SUPER_EASY_SETUP;
    if (setup.compute === 'colab' && !setup.confirmed) {
      options.onSetup?.();
      return;
    }
    const presetField = root.querySelector<HTMLInputElement>('[data-super-easy-length]:checked');
    const customField = root.querySelector<HTMLInputElement>('[data-super-easy-custom-length]');
    const customText = customField?.value.trim() ?? '';
    const selectedLength = presetField ? Number(presetField.value) : customField ? (customText ? Number(customText) : NaN) : options.state().idea.lengthS;
    if (!isLength(selectedLength)) {
      const error = root.querySelector<HTMLElement>('[data-super-easy-length-error]');
      if (error) error.hidden = false;
      customField?.setAttribute?.('aria-invalid', 'true');
      customField?.focus();
      return;
    }
    const lengthS = selectedLength;
    if (!presetField && lengthS !== options.state().idea.lengthS) options.onLengthChange?.(lengthS);
    freshStart = false;
    const toggle = root.querySelector<HTMLInputElement>('[data-procedure-capture-toggle]');
    const current = options.state();
    if (options.onGenerate) {
      void options.onGenerate({
        prompt,
        compute: setup.compute,
        lengthS,
        motionModel: setup.motionModel ?? 'auto',
        ...(deepSeekNoThinking ? { deepSeekNoThinking: true } : {}),
        ...(selectedVideoType ? { videoType: selectedVideoType } : {}),
        ...(String(selectedVideoType) === 'music-video' && selectedSongTrim ? { songTrim: { ...selectedSongTrim } } : {}),
        ...(includeLyrics() ? { lyricsStyle: selectedLyricsStyle, lyricsLrc: lyricsLrcText } : {}),
        ...(current.chatId ? { conversationId: current.chatId } : {}),
        ...(current.attachmentSignature ? {
          attachmentSignature: current.attachmentSignature,
          attachmentRevision: current.attachmentRevision,
        } : {}),
        ...(setup.compute === 'colab' ? { setupConfirmed: true } : {}),
        ...(toggle ? { capture: toggle.checked === true } : {}),
      });
    }
  };

  function customPromptHint(): string {
    const setup = options.setup?.() ?? DEFAULT_SUPER_EASY_SETUP;
    return setup.compute === 'colab' && setup.confirmed
      ? 'One sentence is enough. Your film is planned, generated, finished and ready to watch here.'
      : COPY.home.hint;
  }

  const onChange = (event: Event): void => {
    const target = event.target as { checked?: boolean; value?: string; files?: FileList | null } | null;
    if (closestOf(event.target)('[data-super-easy-font-file]')) {
      const file = target?.files?.[0];
      const status = root.querySelector<HTMLElement>('[data-super-easy-font-status]');
      const rights = root.querySelector<HTMLInputElement>('[data-super-easy-font-rights]');
      if (!file || !status) return;
      if (fontPending || !options.onFontUpload) return;
      if (!rights?.checked) { status.textContent = 'Please confirm font usage rights first.'; return; }
      fontPending = true;
      status.textContent = 'Uploading font…';
      const generate = root.querySelector<HTMLButtonElement>('[data-super-easy-generate]');
      if (generate) generate.disabled = true;
      void options.onFontUpload(file).then(message => { status.textContent = message; }).catch(error => { status.textContent = error instanceof Error ? error.message : 'Font upload failed.'; }).finally(() => { fontPending = false; if (generate) generate.disabled = false; });
      return;
    }
    if (closestOf(event.target)('[data-super-easy-deepseek-no-thinking]')) {
      deepSeekNoThinking = target?.checked === true;
      return;
    }
    if (closestOf(event.target)('[data-super-easy-music-aspect]')) {
      const value = target?.value;
      if (value === '16:9' || value === '9:16' || value === '1:1') options.onAspectChange?.(value);
      return;
    }
    if (closestOf(event.target)('[data-super-easy-lyrics-style]')) {
      selectedLyricsStyle = target?.value === 'caption' || target?.value === 'reel' ? target.value : 'off';
      options.onLyricsStyleChange?.(selectedLyricsStyle);
      return;
    }
    if (closestOf(event.target)('[data-super-easy-song-start]') || closestOf(event.target)('[data-super-easy-song-end]')) {
      updateSongTrimFromFields();
      return;
    }
    if (closestOf(event.target)('[data-super-easy-video-type]')) {
      const value = target?.value;
      const next = isVideoType(value) ? value : null;
      selectedVideoType = next;
      options.onVideoTypeChange?.(next);
      const metadata = videoTypeMetadata(next);
      const prompt = root.querySelector<HTMLTextAreaElement>('#super-easy-prompt');
      if (prompt) prompt.placeholder = metadata?.promptPlaceholder ?? SUPER_EASY_EXAMPLE_PROMPT;
      const hint = root.querySelector<HTMLElement>('[data-super-easy-prompt-hint]');
      if (hint) hint.textContent = metadata?.inputHint ?? customPromptHint();
      for (const card of Array.from(root.querySelectorAll?.('[data-super-easy-video-type]') ?? [])) {
        const input = card as HTMLInputElement;
        input.closest('.super-easy-video-type')?.classList.toggle('is-selected', input.checked);
      }
      syncSongTrim();
      syncLyrics();
      syncAttachments();
      return;
    }
    if (closestOf(event.target)('[data-super-easy-context-files]')) {
      const files = target?.files ? Array.from(target.files) : [];
      void options.attachments?.attachFiles(files);
      return;
    }
    const usage = closestOf(event.target)('[data-super-easy-context-usage]');
    if (usage) {
      void options.attachments?.setUsage(usage.getAttribute('data-super-easy-context-usage') ?? '', target?.checked === true);
      return;
    }
    const note = closestOf(event.target)('[data-super-easy-context-note]');
    if (note) {
      const id = note.getAttribute('data-super-easy-context-note') ?? '';
      const key = `media:${id}`;
      const submitted = target?.value ?? '';
      void options.attachments?.setNote(id, submitted).then(saved => {
        if (saved && dirtyAttachmentNotes.get(key) === submitted) dirtyAttachmentNotes.delete(key);
      });
      return;
    }
    if (closestOf(event.target)('[data-super-easy-length]')) {
      const lengthS = Number(target?.value);
      if (isLength(lengthS)) {
        const custom = root.querySelector<HTMLInputElement>('[data-super-easy-custom-length]');
        if (custom) { custom.value = ''; custom.removeAttribute?.('aria-invalid'); }
        const error = root.querySelector<HTMLElement>('[data-super-easy-length-error]');
        if (error) error.hidden = true;
        options.onLengthChange?.(lengthS);
        syncSongTrim();
      }
      return;
    }
    if (closestOf(event.target)('[data-super-easy-motion-model]')) {
      const model = target?.value === 'h3' || target?.value === 'ltx' || target?.value === 'klein' ? target.value : 'auto';
      options.onMotionModelChange?.(model);
      return;
    }
    if (!closestOf(event.target)('[data-procedure-capture-toggle]')) return;
    options.onCaptureToggle?.(target?.checked === true);
  };

  function progressOptions(snapshot: unknown): SuperEasyProgressViewOptions {
    const state = options.state();
    const failure = options.failure?.() ?? null;
    const stages = options.stages?.(snapshot);
    const gallery = options.gallery?.(snapshot);
    return {
      ...(stages === undefined ? {} : { stages }),
      ...(gallery === undefined ? {} : { gallery }),
      ...(options.reducedMotion === undefined ? {} : { reducedMotion: options.reducedMotion }),
      packageId: state.packageId,
      search: currentSearch(),
      previewReady: options.previewReady?.() === true,
      ...(failure === null
        ? {}
        : {
            failure: {
              message: failure.message,
              retryable: failure.retryable !== false && typeof options.onRetry === 'function',
              narrationRevision: Boolean(failure.narrationRevision && options.onReviseNarration),
              proposalRevisionNote: failure.proposalRevisionNote,
              downloadedOutputsRecovery: Boolean(failure.downloadedOutputsRecovery && options.onRecoverDownloadedOutputs),
            },
          }),
    };
  }

  function paintProgress(): void {
    const snapshot = options.snapshot?.() ?? null;
    const viewOptions = progressOptions(snapshot);
    const mounted = root.querySelector('[data-super-easy-chrome]');
    if (!mounted) {
      const parts = superEasyProgressParts(snapshot, viewOptions);
      root.innerHTML = parts.html;
      stopAgentConsole?.();
      stopAgentConsole = mountAgentConsole(root);
      progressKeys = parts.keys;
      return;
    }
    progressKeys = updateSuperEasyProgress(
      root as unknown as ProgressRoot,
      progressKeys,
      snapshot,
      viewOptions,
    );
  }

  function applyDirtyAttachmentNotes(row: HTMLElement): void {
    for (const input of Array.from(row.querySelectorAll<HTMLInputElement>('[data-super-easy-context-note]'))) {
      const id = input.getAttribute('data-super-easy-context-note') ?? '';
      const draft = dirtyAttachmentNotes.get(`media:${id}`);
      if (draft !== undefined && input.value !== draft) input.value = draft;
    }
  }

  function attachmentRow(list: HTMLElement, html: string): HTMLElement | null {
    const doc = list.ownerDocument ?? root.ownerDocument;
    if (!doc || typeof doc.createElement !== 'function') return null;
    const temporary = doc.createElement('ul');
    temporary.innerHTML = html;
    return temporary.firstElementChild as HTMLElement | null;
  }

  function attachmentFocus(row: HTMLElement): { selector: string; start: number | null; end: number | null } | null {
    const active = row.ownerDocument?.activeElement as HTMLElement | null | undefined;
    if (!active || !row.contains(active)) return null;
    for (const selector of [
      '[data-super-easy-context-note]',
      '[data-super-easy-context-usage]',
      '[data-super-easy-context-remove]',
    ]) {
      if (!active.matches(selector)) continue;
      const input = active as HTMLInputElement;
      return {
        selector,
        start: selector.includes('context-note') ? input.selectionStart : null,
        end: selector.includes('context-note') ? input.selectionEnd : null,
      };
    }
    return null;
  }

  function restoreAttachmentFocus(row: HTMLElement, focus: { selector: string; start: number | null; end: number | null } | null): void {
    if (!focus) return;
    const control = row.querySelector<HTMLInputElement>(focus.selector);
    if (!control) return;
    control.focus();
    if (focus.start !== null && focus.end !== null && typeof control.setSelectionRange === 'function') {
      control.setSelectionRange(focus.start, focus.end);
    }
  }

  function reconcileAttachmentRows(list: HTMLElement, attachments: ReturnType<SuperEasyContextAttachments['snapshot']>['attachments']): void {
    if (attachments.length === 0) {
      list.innerHTML = renderContextAttachmentItems([], selectedVideoType);
      renderedAttachmentRows = new Map();
      return;
    }
    const existing = new Map<string, HTMLElement>();
    for (const row of Array.from(list.querySelectorAll<HTMLElement>('li[data-context-source][data-context-id]'))) {
      existing.set(`${row.getAttribute('data-context-source')}:${row.getAttribute('data-context-id')}`, row);
    }
    const used = new Set<string>();
    const nextRows = new Map<string, string>();
    attachments.forEach((item, index) => {
      const key = `${item.source}:${item.id}`;
      const html = renderContextAttachmentItems([item], selectedVideoType);
      let row = existing.get(key) ?? null;
      if (row && renderedAttachmentRows.get(key) !== html) {
        const focused = attachmentFocus(row);
        const replacement = attachmentRow(list, html);
        if (replacement) {
          applyDirtyAttachmentNotes(replacement);
          list.replaceChild(replacement, row);
          row = replacement;
          restoreAttachmentFocus(row, focused);
        }
      } else if (!row) {
        row = attachmentRow(list, html);
      }
      if (!row) return;
      applyDirtyAttachmentNotes(row);
      const atIndex = list.children[index] ?? null;
      if (atIndex !== row) {
        const focused = attachmentFocus(row);
        list.insertBefore(row, atIndex);
        restoreAttachmentFocus(row, focused);
      }
      used.add(key);
      nextRows.set(key, html);
    });
    for (const [key, row] of existing) {
      if (!used.has(key)) row.remove();
    }
    list.querySelector('.super-easy-context-empty')?.remove();
    renderedAttachmentRows = nextRows;
  }

  function syncAttachments(): void {
    const controller = options.attachments;
    if (!controller || destroyed) return;
    const snapshot = controller.snapshot();
    songPreview?.sync();
    const list = root.querySelector<HTMLElement>('[data-super-easy-context-list]');
    const renderKey = `${String(selectedVideoType)}|${snapshot.attachmentSignature ?? ''}`;
    if (list && list !== renderedAttachmentList) {
      list.innerHTML = renderContextAttachmentItems(snapshot.attachments, selectedVideoType);
      for (const row of Array.from(list.querySelectorAll<HTMLElement>('li[data-context-source][data-context-id]'))) {
        applyDirtyAttachmentNotes(row);
      }
      renderedAttachmentList = list;
      renderedAttachmentKey = renderKey;
      renderedAttachmentRows = new Map(snapshot.attachments.map(item => [
        `${item.source}:${item.id}`,
        renderContextAttachmentItems([item], selectedVideoType),
      ]));
    } else if (list && renderKey !== renderedAttachmentKey) {
      reconcileAttachmentRows(list, snapshot.attachments);
      renderedAttachmentKey = renderKey;
    } else if (!list) {
      renderedAttachmentList = null;
      renderedAttachmentKey = null;
      renderedAttachmentRows = new Map();
    }
    const pending = root.querySelector<HTMLElement>('[data-super-easy-context-pending]');
    if (pending) pending.innerHTML = renderContextAttachmentStatus(snapshot);
    const status = root.querySelector<HTMLElement>('[data-super-easy-context-status]');
    if (status) {
      status.textContent = snapshot.message;
      status.classList.toggle('is-error', snapshot.messageError);
    }
  }

  function loadAttachments(): void {
    const chatId = options.state().chatId;
    if (!options.attachments || !chatId || attachmentLoadKey === chatId) return;
    attachmentLoadKey = chatId;
    void options.attachments.reload();
  }

  const render = (update: { forceHome?: boolean } = {}): void => {
    if (destroyed) return;
    const next = screenNow();
    if (next === 'home' && current === 'home' && update.forceHome !== true && root.querySelector('[data-super-easy-home]')) {
      // Gallery, snapshot and preference callbacks must not replace a prompt
      // that is actively being composed. Setup changes opt into a full repaint.
      return;
    }
    songPreview?.clear();
    current = next;
    const proposal = options.proposal?.() ?? null;
    if (next !== 'progress' || proposal) {
      stopAgentConsole?.();
      stopAgentConsole = null;
    }
    if (next === 'progress' && proposal) {
      root.innerHTML = renderSuperEasyProposal(proposal);
      progressKeys = null;
    } else if (next === 'progress') {
      paintProgress();
    } else {
      progressKeys = null;
      const state = options.state();
      root.innerHTML = renderSuperEasyHome({
        prompt: promptText,
        deepSeekNoThinking,
        packageId: state.packageId,
        search: currentSearch(),
        setup: options.setup?.() ?? DEFAULT_SUPER_EASY_SETUP,
        lengthS: state.idea.lengthS,
        aspect: state.idea.aspect,
        videoType: selectedVideoType,
        songTrim: selectedSongTrim,
        lyricsStyle: selectedLyricsStyle,
        lyricsLrc: lyricsLrcText,
        ...(options.captureArmed ? { capture: { armed: options.captureArmed() } } : {}),
      });
      // Assign after parsing as well so an initial newline in the raw draft is exact.
      const lyricsField = root.querySelector<HTMLTextAreaElement>('[data-super-easy-lyrics-lrc]');
      if (lyricsField && lyricsField.value !== lyricsLrcText) lyricsField.value = lyricsLrcText;
      syncSongTrim();
      syncLyrics();
      syncAttachments();
      loadAttachments();
    }
    root.dataset.superEasyView = next;
  };

  render();
  root.addEventListener('click', onClick);
  root.addEventListener('submit', onSubmit);
  root.addEventListener('change', onChange);
  root.addEventListener('input', onInput);
  const unsubscribe = options.subscribe?.(() => {
    if (destroyed) return;
    // The home keeps the person's typed prompt; only a screen change or a
    // progress update needs a repaint. A switch into progress always repaints.
    if (!freshStart && screenNow() === 'home' && current === 'home') return;
    render();
  }) ?? (() => {});

  return {
    render,
    syncAttachments,
    screen: () => current,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      unsubscribe();
      songPreview?.destroy();
      root.removeEventListener('click', onClick);
      root.removeEventListener('submit', onSubmit);
      root.removeEventListener('change', onChange);
      root.removeEventListener('input', onInput);
      stopAgentConsole?.();
      stopAgentConsole = null;
      root.innerHTML = '';
      progressKeys = null;
      delete root.dataset.superEasyView;
    },
  };
}
