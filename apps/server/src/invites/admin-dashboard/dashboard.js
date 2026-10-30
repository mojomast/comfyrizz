(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  let token = '';
  let session = 0;
  let busy = false;
  const number = value => Number.isFinite(Number(value)) ? new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 }).format(Number(value)) : '—';
  const date = value => Number.isFinite(Number(value)) ? new Date(Number(value)).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—';
  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  function notice(message, isError = false) {
    const node = $('notice');
    node.textContent = message;
    node.classList.toggle('error', isError);
    node.hidden = !message;
  }
  async function request(path, options = {}) {
    const response = await fetch(path, {
      method: options.method || 'GET', redirect: 'error', cache: 'no-store',
      headers: { 'x-comfyrizz-token': token, ...(options.body ? { 'content-type': 'application/json' } : {}) },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    });
    let body = {};
    try { body = await response.json(); } catch { /* display the HTTP status instead */ }
    if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
    return body;
  }
  function metric(label, value) {
    const item = element('span');
    item.append(`${label} `, element('b', '', value));
    return item;
  }
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
  function renderInvite(invite) {
    const card = element('article', 'invite');
    const header = element('div', 'invite-head');
    const title = element('div');
    title.append(element('div', 'invite-title', invite.label || 'Untitled invite'), element('div', 'invite-id', invite.id));
    const badge = element('span', `badge ${['active', 'revoked', 'expired'].includes(invite.status) ? invite.status : ''}`, invite.status || 'unknown');
    header.append(title, badge);
    const metrics = element('div', 'metrics');
    metrics.append(metric('Visits', number(invite.visits)), metric('Last visit', invite.lastVisitAt ? date(invite.lastVisitAt) : 'Never'));
    metrics.append(metric('Budget', `${number(invite.spendCeilingCu)} CU`), metric('Recorded charges (may include estimates)', `${number(invite.spentEstimateCu)} CU`), metric('Reserved', `${number(invite.committedEstimateCu)} CU`), metric('Remaining', `${number(invite.remainingCu)} CU`), metric('Films', `${number(invite.filmsCompleted)} / ${Number(invite.maxFilms) === 0 ? '∞' : number(invite.maxFilms)}`), metric('Expires', date(invite.expiresAt)));
    const actions = element('div', 'invite-actions');
    const generations = Array.isArray(invite.generations) ? invite.generations : [];
    const toggle = element('button', 'link', `Generations (${generations.length})`);
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', 'false');
    const details = element('div', 'generations');
    details.hidden = true;
    if (!generations.length) details.append(element('p', 'muted', 'No generations recorded yet.'));
    for (const generation of [...generations].reverse()) {
      const row = element('div', 'generation');
      row.append(element('strong', '', generation.title || 'Untitled generation'));
      row.append(element('p', '', `${generation.status || 'unknown'} · ${date(generation.createdAt)}`));
      row.append(element('p', 'generation-accounting', usageLabel(generation.details?.accounting,
        generation.details?.reservedEstimateCu, generation.spentEstimateCu)));
      if (generation.prompt) row.append(element('p', '', generation.prompt));
      const models = generation.details?.models ?? [];
      row.append(element('p', '', `Models used: ${models.map(m => `${m.name} (${m.role})${m.checkpoint ? ` · ${m.checkpoint}` : ''}`).join(', ') || 'Not recorded'}`));
      if (!models.length && generation.details?.plannedModels?.length) row.append(element('p', 'muted',
        `Planned models: ${generation.details.plannedModels.map(m => `${m.name} (${m.role})`).join(', ')}`));
      if (generation.details?.planner) row.append(element('p', 'muted', `Planning model: ${generation.details.planner.name}`));
      if (generation.status === 'ready') {
        const play = element('button', 'link', 'Watch video'); play.type = 'button';
        const video = element('video', 'generation-video'); video.controls = true; video.preload = 'none'; video.playsInline = true; video.hidden = true;
        video.setAttribute('aria-label', generation.title || 'Generated video');
        play.addEventListener('click', async () => {
          const current = session; play.disabled = true;
          try {
            const result = await request(`/api/invites/generations/${encodeURIComponent(generation.id)}/video`);
            if (current !== session) return;
            if (result.status !== 'completed' || !/^\/api\/media\/[a-f0-9]{32}$/.test(result.url)) throw new Error('Video is unavailable.');
            video.src = result.url; video.hidden = false; await video.play(); play.textContent = 'Refresh video';
          } catch (error) { if (current === session) notice(error.message, true); }
          finally { play.disabled = false; }
        });
        row.append(play, video);
      }
      details.append(row);
    }
    toggle.addEventListener('click', () => {
      details.hidden = !details.hidden;
      toggle.setAttribute('aria-expanded', String(!details.hidden));
    });
    actions.append(toggle);
    if (invite.status !== 'revoked') {
      const revoke = element('button', 'link danger', 'Revoke');
      revoke.type = 'button';
      revoke.addEventListener('click', async () => {
        if (!confirm(`Revoke ${invite.label || 'this invite'}? Its guest sessions and video access will stop working.`)) return;
        const current = session;
        revoke.disabled = true;
        try {
          await request(`/api/invites/${encodeURIComponent(invite.id)}/revoke`, { method: 'POST' });
          if (current !== session) return;
          notice('Invite revoked.');
          await refresh();
        } catch (error) { if (current === session) notice(error.message || 'Could not revoke invite.', true); }
        finally { revoke.disabled = false; }
      });
      actions.append(revoke);
    }
    card.append(header, metrics, actions, details);
    return card;
  }
  function render(data) {
    const totals = data.totals || {};
    const invites = Array.isArray(data.invites) ? data.invites : [];
    $('total-invites').textContent = number(totals.inviteCount);
    $('total-budget').textContent = number(totals.ceilingCu);
    $('total-spent').textContent = number(totals.spentEstimateCu);
    $('total-reserved').textContent = number(totals.committedEstimateCu);
    $('activity-stats').textContent = `${number(totals.visits)} visits · ${number(totals.generationCount)} generations · ${number(totals.runningCount)} running · ${number(totals.readyCount)} ready · ${number(totals.failedCount)} failed/cancelled`;
    $('invite-count').textContent = number(invites.length);
    $('empty').hidden = invites.length > 0;
    stopVideos();
    $('invites').replaceChildren(...[...invites].sort((a, b) => Number(b.createdAt) - Number(a.createdAt)).map(renderInvite));
  }
  async function refresh() {
    const current = session;
    const [data, status] = await Promise.all([request('/api/invites'), request('/api/invites/admin-status')]);
    if (current === session && token) {
      render(data);
      $('spend-status').hidden = status.spendEnabled === true;
      $('spend-status').textContent = 'Guest compute is disabled. You can create invites, but guests cannot generate videos yet.';
    }
  }
  function signOut() {
    session++;
    token = '';
    $('token').value = '';
    $('minted-url').value = '';
    $('minted').hidden = true;
    stopVideos();
    $('invites').replaceChildren();
    $('dashboard').hidden = true;
    $('sign-out').hidden = true;
    $('login').hidden = false;
    $('login-error').hidden = true;
    notice('');
  }
  function stopVideos() {
    for (const video of document.querySelectorAll('video')) { video.pause(); video.removeAttribute('src'); video.load(); }
  }
  $('login-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (busy) return;
    busy = true;
    const current = ++session;
    token = $('token').value.trim();
    $('token').value = '';
    const button = event.currentTarget.querySelector('button');
    button.disabled = true;
    $('login-error').hidden = true;
    try {
      await refresh();
      if (current !== session) return;
      $('login').hidden = true;
      $('dashboard').hidden = false;
      $('sign-out').hidden = false;
    } catch (error) {
      token = '';
      $('login-error').textContent = error.message || 'Could not connect to the admin API.';
      $('login-error').hidden = false;
    } finally { busy = false; button.disabled = false; }
  });
  $('sign-out').addEventListener('click', signOut);
  $('refresh').addEventListener('click', async () => {
    const current = session;
    $('refresh').disabled = true;
    try { await refresh(); if (current === session) notice('Dashboard updated.'); }
    catch (error) { if (current === session) notice(error.message || 'Could not refresh.', true); }
    finally { $('refresh').disabled = false; }
  });
  $('mint-form').addEventListener('submit', async event => {
    event.preventDefault();
    const cu = Number($('cu').value), ttl = Number($('ttl').value), maxFilms = Number($('films').value);
    if (!(cu >= 0.001) || !Number.isFinite(cu) || !(ttl > 0) || !Number.isFinite(ttl) || !Number.isSafeInteger(maxFilms) || maxFilms < 0) {
      notice('Enter a positive CU budget and expiry, and a whole-number film limit.', true); return;
    }
    const body = { cu, maxFilms, label: $('label').value.trim(), ttlSeconds: ttl * ($('ttl-unit').value === 'hours' ? 3600 : 86400) };
    const current = session;
    $('mint').disabled = true;
    try {
      const result = await request('/api/invites/mint', { method: 'POST', body });
      if (current !== session) return;
      $('minted-url').value = result.url;
      $('copy').textContent = 'Copy invite link';
      $('minted').hidden = false;
      notice('Invite created. Copy the link below; it cannot be retrieved later.');
      try { await refresh(); } catch { if (current === session) notice('Invite created; copy the link below. The invite list could not be refreshed.', true); }
    } catch (error) { if (current === session) notice(error.message || 'Could not create invite.', true); }
    finally { $('mint').disabled = false; }
  });
  $('copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('minted-url').value); $('copy').textContent = 'Copied!'; }
    catch { $('minted-url').select(); notice('Select and copy the invite link below.'); }
  });
})();
