(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const key = 'comfyrizz-guest-gallery-token';
  const incoming = new URLSearchParams(location.hash.slice(1)).get('token');
  let token = incoming || sessionStorage.getItem(key) || '';
  if (incoming) { sessionStorage.setItem(key, token); history.replaceState(null, '', location.pathname); }
  let next = null, busy = false;
  const el = (tag, cls, text) => { const n = document.createElement(tag); n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  function usageLabel(accounting, reserved, estimate) {
    const amount = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
    const cu = value => value.toLocaleString(undefined, { maximumFractionDigits: 3 });
    if (accounting?.status === 'not_required' && accounting.costSource === 'cpu_no_colab_spend' && accounting.actualSpendCu === 0) {
      return 'CPU render · 0 CU (no Colab allocation)';
    }
    if (accounting?.status === 'settled' && accounting.shutdownVerified === true && amount(accounting.actualSpendCu)
        && (accounting.costSource === 'verified_session_usage'
          || accounting.costSource === 'verified_no_allocation' && accounting.actualSpendCu === 0)) {
      const released = amount(reserved) && reserved >= accounting.actualSpendCu
        ? ` · ${cu(Math.round((reserved - accounting.actualSpendCu) * 1000) / 1000)} CU unused released` : '';
      return `Verified actual usage: ${cu(accounting.actualSpendCu)} CU · 0 CU held${released}`;
    }
    if (accounting?.status === 'legacy_estimate') {
      return `Legacy estimate: ${amount(estimate) ? `${cu(estimate)} CU` : 'unavailable'} · actual usage unverified`;
    }
    if (!accounting && amount(estimate) && estimate > 0) return `Historical estimate: ${cu(estimate)} CU · actual usage unverified`;
    if (accounting?.status === 'reserved') return `Usage pending${amount(reserved) ? ` · ${cu(reserved)} CU reserved` : '; CU reserved'}`;
    return `Usage indeterminate${accounting?.status === 'unresolved' || amount(reserved) && reserved > 0
      ? `; CU reserved${amount(reserved) ? ` · ${cu(reserved)} CU held` : ''}` : ''}`;
  }
  async function api(path, method = 'GET') {
    const r = await fetch(path, { method, headers: { 'x-comfyrizz-token': token }, cache: 'no-store', redirect: 'error' });
    if (r.status === 401) { sessionStorage.removeItem(key); token = ''; throw new Error('Your session ended. Open your original invite link again.'); }
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'The gallery could not be loaded.');
    return data;
  }
  function card(row) {
    const article = el('article', 'film');
    const video = el('video', ''); video.controls = true; video.preload = 'none'; video.playsInline = true;
    video.setAttribute('aria-label', row.title);
    const body = el('div', 'body');
    body.append(el('h2', '', row.title), el('p', 'meta', `${new Date(row.createdAt).toLocaleString()}${row.fromThisInvite ? ' · From your invite' : ''}`));
    // Billing details belong to this invite, not to every gallery viewer.
    if (row.fromThisInvite === true) body.append(el('p', 'meta', usageLabel(row.accounting,
      row.accounting?.reservedEstimateCu, row.accounting?.legacyEstimateCu)));
    const play = el('button', '', 'Watch film'); play.type = 'button';
    play.addEventListener('click', async () => {
      play.disabled = true;
      try {
        const result = await api(row.videoApiPath);
        if (result.status !== 'completed' || !/^\/api\/media\/[a-f0-9]{32}$/.test(result.url)) throw new Error('This video is unavailable.');
        video.src = result.url;
        await video.play();
        play.textContent = 'Reload video';
      } catch (e) { $('notice').textContent = e.message; }
      finally { play.disabled = false; }
    });
    video.addEventListener('error', () => { play.textContent = 'Refresh video access'; });
    const prompt = el('details', ''); prompt.append(el('summary', '', 'View prompt'), el('p', 'prompt', row.prompt || 'Prompt not recorded.'));
    const used = row.models?.map(m => `${m.name} (${m.role})${m.checkpoint ? ` · ${m.checkpoint}` : ''}`).join(', ');
    const planned = row.plannedModels?.map(m => `${m.name} (${m.role})`).join(', ');
    const models = el('div', 'models', `Models used: ${used || 'Not recorded for this older generation.'}`);
    if (!used && planned) models.append(el('p', '', `Planned models (not verified usage): ${planned}`));
    if (row.planner) models.append(el('p', '', `Planning: ${row.planner.name}${row.planner.provider ? ` · ${row.planner.provider}` : ''}`));
    const edit = el('button', '', 'Edit with agent'); edit.type = 'button';
    edit.addEventListener('click', async () => {
      edit.disabled = true;
      try {
        const result = await api(row.editApiPath, 'POST');
        location.href = `${result.openPath}#token=${encodeURIComponent(token)}`;
      } catch (error) { $('notice').textContent = error.message; edit.disabled = false; }
    });
    body.append(play, edit, prompt, models); article.append(video, body); return article;
  }
  async function load(reset = true) {
    if (busy) return;
    if (!token) { $('notice').textContent = 'Open your private invite link to enter the gallery.'; return; }
    busy = true; $('refresh').disabled = true; $('more').disabled = true;
    try {
      const [session, gallery] = await Promise.all([api('/api/invites/session'), api(`/api/demo/generations?offset=${reset ? 0 : next || 0}`)]);
      $('budget').textContent = `${session.budgetUnits.toFixed(3)} CU remaining · Shared invite budget · CPU edits remain available${session.spendEnabled ? '' : ' · Colab generation is paused'}`;
      $('easy').href = `${session.easyPath}#token=${encodeURIComponent(token)}`; $('easy').hidden = false;
      if (reset) { for (const v of $('films').querySelectorAll('video')) { v.pause(); v.removeAttribute('src'); v.load(); } $('films').replaceChildren(); }
      $('films').append(...gallery.items.map(card)); next = gallery.nextOffset;
      $('more').hidden = next === null; $('empty').hidden = gallery.total > 0;
      $('notice').textContent = `${gallery.total} shared film${gallery.total === 1 ? '' : 's'}.`;
    } catch (e) { $('notice').textContent = e.message; }
    finally { busy = false; $('refresh').disabled = false; $('more').disabled = false; }
  }
  $('refresh').addEventListener('click', () => load()); $('more').addEventListener('click', () => load(false));
  load();
})();
