import { COPY, fill } from '../copy.ts';
import {
  escapeHtml,
  renderEmptyState,
  renderErrorState,
} from '../components.ts';
import {
  createCharacterApi,
  type CastEntry,
  type CharacterApi,
} from '../../characters/api.ts';
import { openLibraryPicker } from '../dialogs/library-picker.ts';
import { openQuickCharacter } from '../dialogs/quick-character.ts';
import type {
  EasyCastMember,
  EasyState,
  EasyStepContext,
  EasyStepModule,
} from '../types.ts';

const LOAD_ERROR_TEXT = "Couldn't load the characters for this video.";
const CHARACTER_FALLBACK_NAME = 'Character';

type CharactersState = Pick<EasyState, 'cast' | 'narration'>;

export function isCastNotFound(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const record = error as { status?: unknown; code?: unknown; error?: unknown };
  const code = record.code ?? record.error;
  return Number(record.status) === 404 || code === 'NOT_FOUND';
}

export function roleLabel(role: unknown): string {
  const roles = COPY.characters.roles as Record<string, string>;
  return roles[String(role ?? '')] ?? roles.supporting;
}

export function voicePickLine(member: Pick<EasyCastMember, 'voiceLabel'>): string {
  const label = String(member?.voiceLabel ?? '').trim();
  return label ? fill(COPY.characters.voiceLine, { name: label }) : COPY.characters.noVoice;
}

export function castMemberFromEntry(entry: CastEntry): EasyCastMember {
  const snapshot = entry?.snapshot;
  const role = entry?.overrides?.role ?? snapshot?.role;
  const voice = snapshot?.voice;
  const voiceId = typeof voice?.voice === 'string' && voice.voice ? voice.voice : null;
  const voiceLabel = voice && voice.engine !== 'none' ? voiceId : null;
  return {
    castId: String(entry?.castId ?? ''),
    characterId: String(entry?.characterId ?? snapshot?.id ?? ''),
    name: String(snapshot?.name ?? ''),
    role: String(role ?? 'supporting'),
    voiceId,
    voiceLabel,
    imageUrl: null,
  };
}

export function castMembersFromEntries(entries: readonly CastEntry[]): EasyCastMember[] {
  return entries.map(castMemberFromEntry);
}

function memberName(member: Pick<EasyCastMember, 'name'>): string {
  return String(member?.name ?? '').trim() || CHARACTER_FALLBACK_NAME;
}

function initialFor(name: string): string {
  return name.slice(0, 1).toUpperCase() || '?';
}

function removeLabel(member: Pick<EasyCastMember, 'name'>): string {
  return fill(COPY.characters.removeLabel, { name: memberName(member) });
}

export function renderCastCard(member: EasyCastMember): string {
  const name = memberName(member);
  const castId = escapeHtml(member.castId);
  const image = member.imageUrl
    ? `<img class="easy-cast-thumb" data-easy-cast-thumb="${castId}" src="${escapeHtml(member.imageUrl)}" alt="" loading="lazy" decoding="async" />`
    : `<img class="easy-cast-thumb" data-easy-cast-thumb="${castId}" alt="" loading="lazy" decoding="async" hidden /><span class="easy-cast-thumb-empty" data-easy-cast-thumb-empty="${castId}" aria-hidden="true">${escapeHtml(initialFor(name))}</span>`;
  return `<li class="easy-cast-card" data-easy-cast-card="${castId}">
<div class="easy-cast-media">${image}</div>
<div class="easy-cast-body">
<p class="easy-cast-name">${escapeHtml(name)}</p>
<p class="easy-cast-role">${escapeHtml(roleLabel(member.role))}</p>
<p class="easy-cast-voice">${escapeHtml(voicePickLine(member))}</p>
<button type="button" class="btn btn-secondary easy-cast-remove" data-easy-cast-remove="${castId}" aria-label="${escapeHtml(removeLabel(member))}">${escapeHtml(COPY.characters.remove)}</button>
</div>
</li>`;
}

export function renderAddTile(): string {
  return `<div class="easy-cast-add">
<button type="button" class="easy-cast-add-tile" data-easy-add aria-haspopup="menu" aria-expanded="false">${escapeHtml(COPY.characters.add)}</button>
<div class="easy-add-menu" data-easy-add-menu role="menu" hidden>
<button type="button" class="btn btn-secondary" role="menuitem" data-easy-add-library>${escapeHtml(COPY.characters.fromLibrary)}</button>
<button type="button" class="btn btn-secondary" role="menuitem" data-easy-add-create>${escapeHtml(COPY.characters.createNew)}</button>
</div>
</div>`;
}

export function renderNarration(state: Pick<EasyState, 'narration'>): string {
  const on = state?.narration?.on !== false;
  return `<div class="easy-narration">
<label class="easy-narration-toggle"><input type="checkbox" data-easy-narration${on ? ' checked' : ''} /> ${escapeHtml(COPY.characters.narration)}</label>
<div class="easy-narration-voice" data-easy-voice="narrator"></div>
</div>`;
}

export function renderCastEmptyState(): string {
  return renderEmptyState({
    text: COPY.characters.empty,
    actions: [
      {
        label: COPY.characters.emptyAddLibrary,
        data: { 'data-easy-add-library': '' },
      },
      {
        label: COPY.characters.emptyCreate,
        data: { 'data-easy-add-create': '' },
      },
    ],
  });
}

export function renderCharacters(state: CharactersState, error?: unknown): string {
  if (!isCastNotFound(error) && error) {
    return renderErrorState({
      what: LOAD_ERROR_TEXT,
      action: {
        label: COPY.errors.tryAgain,
        data: { 'data-easy-cast-retry': '' },
      },
    });
  }
  const cast = isCastNotFound(error) || !Array.isArray(state?.cast) ? [] : state.cast;
  const body = cast.length
    ? `<p class="easy-cast-heading">${escapeHtml(COPY.characters.inVideo)}</p>
<ul class="easy-cast-list">${cast.map(renderCastCard).join('')}</ul>
${renderAddTile()}`
    : renderCastEmptyState();
  return `<div class="easy-characters" data-easy-characters>
${body}
${renderNarration(state)}
</div>`;
}

function thumbFor(el: HTMLElement, castId: string): HTMLImageElement | null {
  for (const image of el.querySelectorAll<HTMLImageElement>('img[data-easy-cast-thumb]')) {
    if (image.getAttribute('data-easy-cast-thumb') === castId) return image;
  }
  return null;
}

function emptyThumbFor(el: HTMLElement, castId: string): HTMLElement | null {
  for (const item of el.querySelectorAll<HTMLElement>('[data-easy-cast-thumb-empty]')) {
    if (item.getAttribute('data-easy-cast-thumb-empty') === castId) return item;
  }
  return null;
}

export const step: EasyStepModule = {
  id: 'characters',
  heading: COPY.characters.heading,
  intro: COPY.characters.intro,

  primaryLabel: () => COPY.characters.continue,

  render(state) {
    return renderCharacters(state);
  },

  bind(el, ctx) {
    let disposed = false;
    let characterApi: CharacterApi | null = null;
    const objectUrls: string[] = [];

    const currentState = (): EasyState => ctx.store?.get?.() ?? ctx.state;

    function api(): CharacterApi {
      if (!characterApi) {
        characterApi = createCharacterApi({ apiFetch: ctx.host.apiFetch });
      }
      return characterApi;
    }

    function paint(error?: unknown): void {
      el.innerHTML = renderCharacters(currentState(), error);
    }

    function revokeObjectUrls(): void {
      if (typeof URL === 'undefined' || typeof URL.revokeObjectURL !== 'function') return;
      for (const url of objectUrls) URL.revokeObjectURL(url);
      objectUrls.length = 0;
    }

    async function ensureChatId(): Promise<string | null> {
      const state = currentState();
      if (state.chatId) return state.chatId;
      try {
        const created = await ctx.api.createConversation();
        const chatId = typeof created?.chatId === 'string' ? created.chatId : '';
        if (!chatId) return null;
        ctx.store.patch({ chatId });
        return chatId;
      } catch {
        return null;
      }
    }

    async function loadThumbs(cast: readonly EasyCastMember[]): Promise<void> {
      if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return;
      for (const member of cast) {
        if (!member.characterId) continue;
        try {
          const blob = await api().primaryThumb(member.characterId);
          if (disposed || !blob) continue;
          const url = URL.createObjectURL(blob);
          objectUrls.push(url);
          const image = thumbFor(el, member.castId);
          if (!image) continue;
          image.src = url;
          image.hidden = false;
          const empty = emptyThumbFor(el, member.castId);
          if (empty) empty.hidden = true;
        } catch {
          continue;
        }
      }
    }

    async function loadCast(): Promise<void> {
      const chatId = await ensureChatId();
      if (disposed || !chatId) return;
      try {
        const entries = await api().listCast(chatId);
        if (disposed) return;
        const cast = castMembersFromEntries(entries);
        ctx.store.patch({ cast });
        paint();
        await loadThumbs(cast);
      } catch (error) {
        if (disposed) return;
        if (isCastNotFound(error)) {
          ctx.store.patch({ cast: [] });
          paint();
          return;
        }
        paint(error);
      }
    }

    function closeMenu(): void {
      const menu = el.querySelector<HTMLElement>('[data-easy-add-menu]');
      if (menu) menu.hidden = true;
      const tile = el.querySelector<HTMLElement>('[data-easy-add]');
      if (tile) tile.setAttribute('aria-expanded', 'false');
    }

    function toggleMenu(tile: HTMLElement): void {
      const menu = el.querySelector<HTMLElement>('[data-easy-add-menu]');
      if (!menu) return;
      const open = menu.hidden;
      menu.hidden = !open;
      tile.setAttribute('aria-expanded', open ? 'true' : 'false');
    }

    async function adoptEntries(entries: readonly CastEntry[] | undefined, fallback: EasyCastMember): Promise<void> {
      const cast = Array.isArray(entries)
        ? castMembersFromEntries(entries)
        : [...currentState().cast, fallback];
      ctx.store.patch({ cast });
      paint();
      await loadThumbs(cast);
    }

    async function addFromLibrary(opener: HTMLElement): Promise<void> {
      closeMenu();
      const chatId = await ensureChatId();
      if (disposed || !chatId) return;
      const result = await openLibraryPicker({ api: api(), chatId, opener });
      if (disposed || !result) return;
      const fallback = result.entry
        ? castMemberFromEntry(result.entry)
        : castMemberFromEntry({ castId: '', characterId: '' } as CastEntry);
      await adoptEntries(result.cast, fallback);
    }

    async function createNew(opener: HTMLElement): Promise<void> {
      closeMenu();
      const make = ctx.dialogs?.quickCharacter;
      const member = typeof make === 'function'
        ? await make({ opener })
        : await (async () => {
          const chatId = await ensureChatId();
          if (disposed || !chatId) return null;
          return openQuickCharacter({ api: api(), chatId, opener });
        })();
      if (disposed || !member) return;
      const cast = currentState().cast.slice();
      if (!cast.some((item) => item.castId === member.castId)) cast.push(member);
      ctx.store.patch({ cast });
      paint();
      await loadThumbs(cast);
    }

    async function removeMember(castId: string): Promise<void> {
      const chatId = await ensureChatId();
      if (disposed || !chatId) return;
      try {
        const result = await api().removeCast(chatId, castId);
        if (disposed) return;
        const cast = Array.isArray(result?.cast) && result.cast.length
          ? castMembersFromEntries(result.cast)
          : currentState().cast.filter((member) => member.castId !== castId);
        ctx.store.patch({ cast });
        paint();
      } catch (error) {
        if (disposed) return;
        if (isCastNotFound(error)) {
          const cast = currentState().cast.filter((member) => member.castId !== castId);
          ctx.store.patch({ cast });
          paint();
          return;
        }
        paint(error);
      }
    }

    async function onClick(event: Event): Promise<void> {
      const target = event.target as Element | null;
      const button = target && 'closest' in target ? target.closest<HTMLButtonElement>('button') : null;
      if (!button || !el.contains(button)) return;
      if (button.matches('[data-easy-add]')) {
        toggleMenu(button);
        return;
      }
      if (button.matches('[data-easy-add-library]')) {
        await addFromLibrary(el.querySelector<HTMLElement>('[data-easy-add]') ?? button);
        return;
      }
      if (button.matches('[data-easy-add-create]')) {
        await createNew(el.querySelector<HTMLElement>('[data-easy-add]') ?? button);
        return;
      }
      if (button.matches('[data-easy-cast-retry]')) {
        void loadCast();
        return;
      }
      const castId = button.getAttribute('data-easy-cast-remove');
      if (castId) await removeMember(castId);
    }

    function onChange(event: Event): void {
      const input = event.target as HTMLInputElement | null;
      if (!input || !input.matches('[data-easy-narration]')) return;
      const state = currentState();
      ctx.store.patch({
        narration: { ...state.narration, on: input.checked },
      });
    }

    el.addEventListener('click', onClick);
    el.addEventListener('change', onChange);
    ctx.shell?.setPrimary?.({ label: COPY.characters.continue });
    paint();
    void loadCast();

    return () => {
      disposed = true;
      el.removeEventListener('click', onClick);
      el.removeEventListener('change', onChange);
      revokeObjectUrls();
    };
  },

  onPrimary(ctx: EasyStepContext) {
    ctx.go('level');
  },
};
