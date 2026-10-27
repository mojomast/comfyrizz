// Whether the next Generate should record the procedure. `?capture=1` arms it
// for a demo link; the checkbox keeps the choice for this tab only.

export const CAPTURE_ARMED_KEY = 'comfyrizz.procedure-capture.armed';

export interface ArmStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function sessionStore(): ArmStorage | null {
  try {
    return (globalThis as { sessionStorage?: ArmStorage }).sessionStorage ?? null;
  } catch {
    return null;
  }
}

export function captureRequested(search: string): boolean {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const value = (params.get('capture') ?? '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'on' || value === 'yes';
}

export function readCaptureArmed(search: string, storage: ArmStorage | null = sessionStore()): boolean {
  if (captureRequested(search)) return true;
  try {
    return storage?.getItem(CAPTURE_ARMED_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeCaptureArmed(armed: boolean, storage: ArmStorage | null = sessionStore()): void {
  try {
    if (armed) storage?.setItem(CAPTURE_ARMED_KEY, '1');
    else storage?.removeItem(CAPTURE_ARMED_KEY);
  } catch {
    /* storage can be blocked; the checkbox still applies to this Generate */
  }
}
