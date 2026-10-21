export type CharacterApiFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type CharacterRole =
  | 'presenter'
  | 'narrator'
  | 'protagonist'
  | 'supporting'
  | 'mascot'
  | 'extra';

export type CharacterKind = 'fictional';
export type CharacterImageView =
  | 'front'
  | 'three_quarter'
  | 'side'
  | 'back'
  | 'expression'
  | 'full_body'
  | 'other';
export type CharacterImageSource = 'upload' | 'generated' | 'reference';
export type SheetStatus = 'none' | 'proposed' | 'ready';
export type IdentityMethod = 'klein_ref' | 'ip_adapter' | 'pulid' | 'lora';
export type VoiceEngine = 'kokoro' | 'qwen3-tts' | 'none';
export type ChunkingMode = 'sentence' | 'paragraph';
export type QwenMode = 'custom' | 'design';
export type VoiceLanguage = 'en-us';

export interface CharacterImage {
  imgId: string;
  view: CharacterImageView;
  primary: boolean;
  source: CharacterImageSource;
  sha256: string;
  width: number;
  height: number;
}

export interface CharacterSheet {
  imgId?: string;
  status: SheetStatus;
  genSeed?: number | null;
}

export interface CharacterIdentity {
  method: IdentityMethod;
  strength?: number;
  loraFile?: string;
}

export interface WardrobeItem {
  id: string;
  label: string;
  prompt: string;
  default: boolean;
}

export interface ExpressionItem {
  id: string;
  label: string;
  prompt: string;
}

export interface CharacterVisual {
  identityPrompt: string;
  negative: string;
  style?: string;
  palette: string[];
  wardrobe: WardrobeItem[];
  expressions: ExpressionItem[];
  images: CharacterImage[];
  sheet: CharacterSheet;
  seed: number | null;
  identity: CharacterIdentity;
}

export interface VoiceBlend {
  voice: string;
  weight: number;
}

export interface CharacterAudition {
  file: string;
  voiceHash: string;
  line?: string;
}

export interface CharacterVoice {
  engine: VoiceEngine;
  voice?: string;
  speed?: number;
  blend?: VoiceBlend[];
  chunking?: ChunkingMode;
  qwen_mode?: QwenMode;
  delivery?: string;
  persona?: string;
  language?: VoiceLanguage;
  presetId?: string;
  sampleLines: string[];
  audition?: CharacterAudition;
}

export interface CharacterBible {
  personality: string;
  mannerisms: string[];
  catchphrases: string[];
  speakingStyle: string;
  do: string[];
  dont: string[];
  notes: string;
}

export interface Character {
  schema: string;
  id: string;
  revision: number;
  name: string;
  handle: string;
  role: CharacterRole;
  kind: CharacterKind;
  summary: string;
  visual: CharacterVisual;
  voice: CharacterVoice;
  bible: CharacterBible;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CharacterInput {
  name: string;
  handle?: string;
  role?: CharacterRole;
  kind?: CharacterKind;
  summary?: string;
  visual?: Partial<CharacterVisual>;
  voice?: Partial<CharacterVoice>;
  bible?: Partial<CharacterBible>;
  tags?: string[];
}

export type CharacterPatch = Partial<CharacterInput>;

export interface RevisionList {
  characterId: string;
  current: number;
  revisions: Character[];
}

export interface ImageUploadResult {
  image: CharacterImage;
  character: Character;
}

export interface CastOverrides {
  wardrobeId?: string;
  expressionId?: string;
  role?: CharacterRole;
}

export interface CastEntry {
  castId: string;
  characterId: string;
  pinnedRevision: number;
  snapshot: Character;
  overrides: CastOverrides;
  detached: boolean;
  orphaned: boolean;
}

export interface CastMutation {
  cast: CastEntry[];
  entry: CastEntry;
  changed?: boolean;
}

export interface AddCastResult extends CastMutation {
  castId: string;
  added: boolean;
}

export interface RemoveCastResult {
  cast: CastEntry[];
  removed: string;
}

export interface CastPatch {
  update?: boolean;
  refresh?: boolean;
  action?: 'update' | 'detach' | 'attach';
  characterId?: string;
  overrides?: CastOverrides;
  replace?: boolean;
  detached?: boolean;
  wardrobeId?: string;
  expressionId?: string;
  role?: CharacterRole;
}

export interface RequestOptions {
  signal?: AbortSignal;
}

export interface UploadImageOptions extends RequestOptions {
  view?: CharacterImageView;
  primary?: boolean;
  filename?: string;
  onProgress?: (progress: { loaded: number; total: number }) => void;
}

export interface AddCastOptions extends RequestOptions {
  castId?: string;
  role?: CharacterRole;
  wardrobeId?: string;
  expressionId?: string;
  overrides?: CastOverrides;
}

export interface CreateCharacterOptions extends RequestOptions {
  fictional?: boolean;
}

export interface CharacterUploadFile {
  name?: string;
  type?: string;
  size?: number;
  arrayBuffer?: () => Promise<ArrayBuffer>;
}

export class CharacterApiError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'CharacterApiError';
    this.status = status;
    if (code) this.code = code;
  }
}

const MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

const CHARACTERS_BASE = '/api/characters';

function encoded(value: string): string {
  return encodeURIComponent(value);
}

export function charactersPath(suffix = ''): string {
  return `${CHARACTERS_BASE}${suffix}`;
}

export function characterPath(id: string, suffix = ''): string {
  return `${CHARACTERS_BASE}/${encoded(id)}${suffix}`;
}

export function castPath(chatId: string, castId?: string, suffix = ''): string {
  const base = `/api/chat/${encoded(chatId)}/cast`;
  return `${castId === undefined ? base : `${base}/${encoded(castId)}`}${suffix}`;
}

function mimeFor(file: CharacterUploadFile): string {
  const declared = String(file?.type ?? '').split(';')[0].trim().toLowerCase();
  if (declared) return declared;
  const name = String(file?.name ?? '').toLowerCase();
  const dot = name.lastIndexOf('.');
  return (dot >= 0 ? MIME_BY_EXTENSION[name.slice(dot + 1)] : undefined) ?? 'application/octet-stream';
}

async function rawBody(file: CharacterUploadFile): Promise<BodyInit> {
  if (typeof Blob !== 'undefined' && file instanceof Blob) return file;
  if (typeof file?.arrayBuffer === 'function') return await file.arrayBuffer();
  return file as unknown as BodyInit;
}

async function errorFor(response: Response): Promise<CharacterApiError> {
  let body: { error?: unknown; code?: unknown } = {};
  try { body = await response.json() as typeof body; } catch { /* non-JSON error page */ }
  const message = typeof body.error === 'string' && body.error ? body.error : `HTTP ${response.status}`;
  const code = typeof body.code === 'string' && body.code ? body.code : undefined;
  return new CharacterApiError(message, response.status, code);
}

async function jsonBody<T>(response: Response): Promise<T> {
  if (!response.ok) throw await errorFor(response);
  return await response.json() as T;
}

async function blobBody(response: Response): Promise<Blob> {
  if (!response.ok) throw await errorFor(response);
  return await response.blob();
}

function signalInit(options?: RequestOptions): RequestInit {
  return options?.signal ? { signal: options.signal } : {};
}

function jsonInit(method: string, body: unknown, options?: RequestOptions): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...signalInit(options),
  };
}

function listOf<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

export function createCharacterApi(options: { apiFetch: CharacterApiFetch }) {
  if (!options || typeof options.apiFetch !== 'function') {
    throw new TypeError('createCharacterApi requires an apiFetch function');
  }
  const apiFetch = options.apiFetch;

  async function list(signal?: AbortSignal): Promise<Character[]> {
    const response = await apiFetch(charactersPath(), signal ? { signal } : {});
    const body = await jsonBody<{ characters?: unknown }>(response);
    return listOf<Character>(body?.characters);
  }

  async function create(input: CharacterInput, createOptions?: CreateCharacterOptions): Promise<Character> {
    const payload: CharacterInput & { fictional?: boolean } = { ...input };
    if (createOptions?.fictional !== undefined) payload.fictional = createOptions.fictional;
    const response = await apiFetch(charactersPath(), jsonInit('POST', payload, createOptions));
    return await jsonBody<Character>(response);
  }

  async function get(id: string, signal?: AbortSignal): Promise<Character> {
    const response = await apiFetch(characterPath(id), signal ? { signal } : {});
    return await jsonBody<Character>(response);
  }

  async function update(
    id: string,
    patch: CharacterPatch,
    updateOptions?: RequestOptions,
  ): Promise<Character> {
    const response = await apiFetch(characterPath(id), jsonInit('PATCH', patch, updateOptions));
    return await jsonBody<Character>(response);
  }

  async function remove(id: string, signal?: AbortSignal): Promise<void> {
    const response = await apiFetch(characterPath(id), {
      method: 'DELETE',
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) throw await errorFor(response);
  }

  async function listRevisions(id: string, signal?: AbortSignal): Promise<RevisionList> {
    const response = await apiFetch(characterPath(id, '/revisions'), signal ? { signal } : {});
    const body = await jsonBody<Partial<RevisionList>>(response);
    return {
      characterId: typeof body?.characterId === 'string' ? body.characterId : id,
      current: Number(body?.current ?? 0),
      revisions: listOf<Character>(body?.revisions),
    };
  }

  async function getRevision(id: string, revision: number, signal?: AbortSignal): Promise<Character> {
    if (!Number.isSafeInteger(revision) || revision < 1) {
      throw new CharacterApiError('revision must be a positive integer', 0, 'INVALID_REVISION');
    }
    const response = await apiFetch(
      characterPath(id, `/revisions/${encodeURIComponent(String(revision))}`),
      signal ? { signal } : {},
    );
    return await jsonBody<Character>(response);
  }

  async function listImages(id: string, signal?: AbortSignal): Promise<CharacterImage[]> {
    const response = await apiFetch(characterPath(id, '/images'), signal ? { signal } : {});
    const body = await jsonBody<{ images?: unknown }>(response);
    return listOf<CharacterImage>(body?.images);
  }

  async function uploadImage(
    id: string,
    file: CharacterUploadFile,
    uploadOptions?: UploadImageOptions,
  ): Promise<ImageUploadResult> {
    const total = Number.isFinite(file?.size) ? Number(file.size) : 0;
    uploadOptions?.onProgress?.({ loaded: 0, total });

    const query = new URLSearchParams();
    if (uploadOptions?.view) query.set('view', uploadOptions.view);
    if (uploadOptions?.primary !== undefined) query.set('primary', uploadOptions.primary ? '1' : '0');
    const suffix = query.size > 0 ? `/images?${query.toString()}` : '/images';
    const filename = uploadOptions?.filename ?? file?.name ?? 'upload';

    const response = await apiFetch(characterPath(id, suffix), {
      method: 'POST',
      headers: {
        'content-type': mimeFor(file),
        'x-filename': encodeURIComponent(filename),
        'x-rights-asserted': '1',
      },
      body: await rawBody(file),
      ...signalInit(uploadOptions),
    });
    const result = await jsonBody<ImageUploadResult>(response);
    uploadOptions?.onProgress?.({ loaded: total, total });
    return result;
  }

  async function primaryThumb(id: string, signal?: AbortSignal): Promise<Blob> {
    const response = await apiFetch(characterPath(id, '/thumb'), signal ? { signal } : {});
    return await blobBody(response);
  }

  async function thumb(id: string, imgId: string, signal?: AbortSignal): Promise<Blob> {
    const response = await apiFetch(
      characterPath(id, `/thumbs/${encodeURIComponent(imgId)}`),
      signal ? { signal } : {},
    );
    return await blobBody(response);
  }

  async function imageFile(id: string, imgId: string, signal?: AbortSignal): Promise<Blob> {
    const response = await apiFetch(
      characterPath(id, `/images/${encodeURIComponent(imgId)}/file`),
      signal ? { signal } : {},
    );
    return await blobBody(response);
  }

  async function listCast(chatId: string, signal?: AbortSignal): Promise<CastEntry[]> {
    const response = await apiFetch(castPath(chatId), signal ? { signal } : {});
    const body = await jsonBody<{ cast?: unknown }>(response);
    return listOf<CastEntry>(body?.cast);
  }

  async function addCast(
    chatId: string,
    characterId: string,
    addOptions?: AddCastOptions,
  ): Promise<AddCastResult> {
    const { signal, ...fields } = addOptions ?? {};
    const response = await apiFetch(
      castPath(chatId),
      jsonInit('POST', { characterId, ...fields }, signal ? { signal } : undefined),
    );
    return await jsonBody<AddCastResult>(response);
  }

  async function getCast(chatId: string, castId: string, signal?: AbortSignal): Promise<CastEntry> {
    const response = await apiFetch(castPath(chatId, castId), signal ? { signal } : {});
    return await jsonBody<CastEntry>(response);
  }

  async function patchCast(
    chatId: string,
    castId: string,
    patch: CastPatch,
    patchOptions?: RequestOptions,
  ): Promise<CastMutation> {
    const response = await apiFetch(
      castPath(chatId, castId),
      jsonInit('PATCH', patch, patchOptions),
    );
    return await jsonBody<CastMutation>(response);
  }

  async function castAction(
    chatId: string,
    castId: string,
    action: 'update' | 'detach' | 'attach',
    actionOptions?: RequestOptions,
  ): Promise<CastMutation> {
    const response = await apiFetch(castPath(chatId, castId, `/${action}`), {
      method: 'POST',
      ...signalInit(actionOptions),
    });
    return await jsonBody<CastMutation>(response);
  }

  function updateCast(chatId: string, castId: string, actionOptions?: RequestOptions): Promise<CastMutation> {
    return castAction(chatId, castId, 'update', actionOptions);
  }

  function detachCast(chatId: string, castId: string, actionOptions?: RequestOptions): Promise<CastMutation> {
    return castAction(chatId, castId, 'detach', actionOptions);
  }

  function attachCast(chatId: string, castId: string, actionOptions?: RequestOptions): Promise<CastMutation> {
    return castAction(chatId, castId, 'attach', actionOptions);
  }

  async function removeCast(
    chatId: string,
    castId: string,
    removeOptions?: RequestOptions,
  ): Promise<RemoveCastResult> {
    const response = await apiFetch(castPath(chatId, castId), {
      method: 'DELETE',
      ...signalInit(removeOptions),
    });
    return await jsonBody<RemoveCastResult>(response);
  }

  return Object.freeze({
    list,
    listCharacters: list,
    create,
    createCharacter: create,
    get,
    getCharacter: get,
    update,
    updateCharacter: update,
    patch: update,
    patchCharacter: update,
    remove,
    delete: remove,
    deleteCharacter: remove,
    listRevisions,
    revisions: listRevisions,
    getRevision,
    listImages,
    uploadImage,
    upload: uploadImage,
    primaryThumb,
    fetchPrimaryThumb: primaryThumb,
    thumb,
    fetchThumb: thumb,
    imageFile,
    file: imageFile,
    fetchImage: imageFile,
    listCast,
    listProjectCast: listCast,
    addCast,
    addToProject: addCast,
    getCast,
    patchCast,
    updateCast,
    detachCast,
    attachCast,
    removeCast,
    removeFromProject: removeCast,
  });
}

export type CharacterApi = ReturnType<typeof createCharacterApi>;
export default createCharacterApi;
