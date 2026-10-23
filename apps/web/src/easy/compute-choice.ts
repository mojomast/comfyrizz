import { COPY, fill } from './copy.ts';
import { escapeHtml } from './components.ts';

export type ComputeChoice = 'cpu' | 'colab';

export interface ComputeColabStatus {
  signedIn?: boolean | null;
  installed?: boolean;
  units?: number | null;
  [key: string]: unknown;
}

export interface ComputeView {
  compute: ComputeChoice;
  colabStatus?: ComputeColabStatus | null;
  spendCap?: number | string | null;
  spent?: number | string | null;
}

export interface ComputeBlockState {
  compute: ComputeChoice;
  spendCap?: number | string | null;
}

export interface ComputeMountOptions {
  apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  colabStatus(): Promise<unknown>;
  onChange(patch: { compute?: ComputeChoice; spendCap?: number | null }): void;
  onStatus?(status: unknown): void;
}

const NOT_CONNECTED_ID = 'easy-compute-not-connected';
const CAP_ERROR_ID = 'easy-cap-error';
const SO_FAR_ID = 'easy-cap-so-far';

let connectCounter = 0;

function capText(spendCap: number | string | null | undefined): string {
  if (spendCap === null || spendCap === undefined) return '';
  const text = String(spendCap).trim();
  return text;
}

function spentText(spent: number | string | null | undefined): string {
  if (spent === null || spent === undefined) return '0';
  const text = String(spent).trim();
  return text === '' ? '0' : text;
}

export function validateCap(value: unknown): string | null {
  if (typeof value !== 'number' && typeof value !== 'string') return COPY.compute.capError;
  const text = String(value).trim();
  if (text === '') return COPY.compute.capError;
  const numeric = Number(text);
  if (!Number.isFinite(numeric)) return COPY.compute.capError;
  if (numeric < 0.5 || numeric > 500) return COPY.compute.capError;
  if (!Number.isInteger(numeric * 2)) return COPY.compute.capError;
  return null;
}

export function computeBlockReason(state: ComputeBlockState, colabStatus: ComputeColabStatus | null): string | null {
  if (state.compute !== 'colab') return null;
  if (colabStatus?.signedIn !== true) return COPY.compute.blockNotConnected;
  if (validateCap(state.spendCap) !== null) return COPY.compute.capError;
  return null;
}

function option(
  value: ComputeChoice,
  title: string,
  body: string,
  checked: boolean,
  disabled: boolean,
): string {
  const disabledAttribute = disabled ? ' disabled' : '';
  const describedBy = disabled ? ` aria-describedby="${NOT_CONNECTED_ID}"` : '';
  const checkedAttribute = checked ? ' checked' : '';
  return `<label class="easy-compute-card${disabled ? ' easy-is-disabled' : ''}"><input class="easy-compute-input" type="radio" name="easy-compute" value="${value}"${checkedAttribute}${disabledAttribute}${describedBy} /><span class="easy-compute-title">${escapeHtml(title)}</span><span class="easy-compute-body">${escapeHtml(body)}</span></label>`;
}

export function renderCompute({ compute, colabStatus, spendCap, spent }: ComputeView): string {
  const selected: ComputeChoice = compute === 'colab' ? 'colab' : 'cpu';
  const connected = colabStatus?.signedIn === true;
  const colabDisabled = !connected;

  const notConnected = colabDisabled
    ? `<div class="easy-compute-status" id="${NOT_CONNECTED_ID}"><span>${escapeHtml(COPY.compute.notConnected)}</span><button type="button" class="btn btn-secondary easy-compute-connect" data-easy-compute-connect>${escapeHtml(COPY.compute.connect)}</button></div>`
    : '';

  const cap = capText(spendCap);
  const capError = cap === '' ? null : validateCap(cap);
  const errorBlock = capError
    ? `<p class="easy-compute-error" id="${CAP_ERROR_ID}" role="alert">${escapeHtml(capError)}</p>`
    : '';
  const describedBy = capError ? `${SO_FAR_ID} ${CAP_ERROR_ID}` : SO_FAR_ID;
  const capBlock =
    selected === 'colab'
      ? `<fieldset class="easy-compute-cap"><legend class="easy-compute-cap-legend">${escapeHtml(COPY.compute.capLegend)}</legend><label class="easy-compute-cap-label" for="easy-cap">${escapeHtml(COPY.compute.capLabel)}</label><div class="easy-compute-cap-row"><input id="easy-cap" class="easy-compute-cap-input" name="easy-cap" type="number" min="0.5" max="500" step="0.5" inputmode="decimal" value="${escapeHtml(cap)}" aria-describedby="${describedBy}"${capError ? ' aria-invalid="true"' : ''} /><span class="easy-compute-cap-suffix">${escapeHtml(COPY.compute.capSuffix)}</span></div><p class="easy-compute-so-far" id="${SO_FAR_ID}">${escapeHtml(fill(COPY.compute.soFar, { spent: spentText(spent) }))}</p>${errorBlock}</fieldset>`
      : '';

  return `<fieldset class="easy-compute"><legend class="easy-compute-legend">${escapeHtml(COPY.compute.legend)}</legend><div class="easy-compute-grid"><div class="easy-compute-option">${option('cpu', COPY.compute.cpuTitle, COPY.compute.cpuBody, selected === 'cpu', false)}</div><div class="easy-compute-option">${option('colab', COPY.compute.colabTitle, COPY.compute.colabBody, selected === 'colab', colabDisabled)}${notConnected}</div></div></fieldset>${capBlock}`;
}

async function openConnectDialog(opener: HTMLElement, options: ComputeMountOptions): Promise<void> {
  const { openDialog } = await import('./dialog.ts');
  const { mountSettingsCard } = await import('../colab-card.ts');
  const document = opener.ownerDocument;
  const hostId = `easy-compute-colab-${++connectCounter}`;
  const result = openDialog({
    title: COPY.compute.connectTitle,
    bodyHtml: `<div id="${hostId}" class="easy-compute-colab-host"></div>`,
    actions: [{ label: 'Close', value: 'close', kind: 'secondary' }],
    opener,
  });
  const host = document.getElementById(hostId);
  if (host) mountSettingsCard(host, options.apiFetch);
  await result;
  const status = await options.colabStatus();
  options.onStatus?.(status);
}

export function mountCompute(root: HTMLElement, options: ComputeMountOptions): () => void {
  const onClick = (event: Event) => {
    const target = event.target as HTMLElement | null;
    const connect = target?.closest<HTMLElement>('[data-easy-compute-connect]');
    if (!connect) return;
    event.preventDefault();
    void openConnectDialog(connect, options);
  };

  const onChange = (event: Event) => {
    const target = event.target as HTMLInputElement | null;
    if (!target) return;
    if (target.name === 'easy-compute' && target.type === 'radio') {
      if (target.value === 'colab') {
        if (target.disabled) return;
        options.onChange({ compute: 'colab' });
      } else if (target.value === 'cpu') {
        options.onChange({ compute: 'cpu' });
      }
      return;
    }
    if (target.id === 'easy-cap') {
      const text = target.value.trim();
      if (text === '') {
        options.onChange({ spendCap: null });
        return;
      }
      const numeric = Number(text);
      options.onChange({ spendCap: Number.isFinite(numeric) ? numeric : null });
    }
  };

  root.addEventListener('click', onClick);
  root.addEventListener('change', onChange);

  return () => {
    root.removeEventListener('click', onClick);
    root.removeEventListener('change', onChange);
  };
}
