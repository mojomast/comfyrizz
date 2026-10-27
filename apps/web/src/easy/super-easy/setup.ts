export interface SuperEasySetup {
  compute: 'cpu' | 'colab';
  /** Default for each new production, not authorization to raise a cap. */
  spendCap: number;
  /** Explicitly saved after connection checks, never inferred from defaults. */
  confirmed: boolean;
}

export const DEFAULT_SUPER_EASY_SETUP: Readonly<SuperEasySetup> = Object.freeze({
  compute: 'cpu', spendCap: 15, confirmed: false,
});

const KEY = 'comfyrizz.super-easy.setup.v1';

function storage(): Storage | null {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

export function readSuperEasySetup(): SuperEasySetup {
  try {
    const value = JSON.parse(storage()?.getItem(KEY) ?? 'null');
    const cap = Number(value?.spendCap);
    return {
      compute: value?.compute === 'colab' ? 'colab' : 'cpu',
      spendCap: Number.isFinite(cap) && cap >= 0.5 && cap <= 500 ? cap : 15,
      confirmed: value?.confirmed === true,
    };
  } catch { return { ...DEFAULT_SUPER_EASY_SETUP }; }
}

export function saveSuperEasySetup(setup: SuperEasySetup): void {
  storage()?.setItem(KEY, JSON.stringify(setup));
}
