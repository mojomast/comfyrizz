type Blocker = { runId: string; session?: string | null; reason: string; canCheck: boolean };

/** Independent of the chat renderer so shutdown remains visible after reload. */
export function mountCorrectionShutdown(root: HTMLElement, apiFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): () => void {
  const doc = root.ownerDocument;
  const panel = doc.createElement('section');
  panel.className = 'easy-banner easy-banner-danger';
  panel.setAttribute('role', 'alert');
  panel.hidden = true;
  root.parentNode?.insertBefore(panel, root);
  let stopped = false;
  let checking = false;

  async function refresh(): Promise<void> {
    try {
      const response = await apiFetch('/api/correction-shutdown');
      if (!response.ok) throw new Error('Shutdown status is unavailable.');
      const data = await response.json() as { blocked?: boolean; blockers?: Blocker[] };
      if (stopped) return;
      panel.replaceChildren();
      panel.hidden = data.blocked !== true;
      if (panel.hidden) return;
      const heading = doc.createElement('strong');
      heading.textContent = 'Google Colab shutdown needs attention';
      panel.append(heading);
      for (const blocker of data.blockers ?? []) {
        const row = doc.createElement('div');
        const description = doc.createElement('p');
        description.textContent = blocker.canCheck
          ? `Run ${blocker.runId} has an unconfirmed shutdown. Inspect Google Colab sessions${blocker.session ? ` (expected name: ${blocker.session})` : ''}; stop only a session you own, then check again.`
          : `Run ${blocker.runId} was interrupted during allocation. Inspect Google Colab sessions and contact support; an empty listing cannot prove the allocation has finished.`;
        row.append(description);
        if (blocker.canCheck) {
          const button = doc.createElement('button');
          button.type = 'button'; button.className = 'btn btn-secondary';
          button.textContent = 'Check shutdown'; button.disabled = checking;
          button.addEventListener('click', async () => {
            if (checking) return;
            checking = true; button.disabled = true;
            const result = doc.createElement('p'); row.append(result);
            try {
              const checked = await apiFetch(`/api/correction-shutdown/${encodeURIComponent(blocker.runId)}/check`, { method: 'POST' });
              const body = await checked.json() as { message?: string; error?: string; confirmed?: boolean };
              if (!checked.ok) throw new Error(body.error || 'Shutdown could not be checked.');
              result.textContent = body.message || 'Shutdown remains unconfirmed.';
              if (body.confirmed) await refresh();
            } catch (error) { result.textContent = error instanceof Error ? error.message : 'Shutdown could not be checked.'; }
            finally { checking = false; button.disabled = false; }
          });
          row.append(button);
        }
        panel.append(row);
      }
    } catch {
      if (!stopped) {
        panel.hidden = false;
        panel.textContent = 'Google Colab shutdown status is unavailable. Reconnect to the local server before starting more generation.';
      }
    }
  }
  const onFocus = () => { void refresh(); };
  doc.defaultView?.addEventListener('focus', onFocus);
  const timer = doc.defaultView?.setInterval(onFocus, 15000);
  void refresh();
  return () => {
    stopped = true;
    if (timer !== undefined) doc.defaultView?.clearInterval(timer);
    doc.defaultView?.removeEventListener('focus', onFocus);
    panel.remove();
  };
}
