import { randomUUID } from 'node:crypto';
import { copyFileSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, join, sep } from 'node:path';
import { guestProductionResult } from './guest-result.mjs';

// Showcase exposes only explicitly recorded, completed guest generations. An
// open creates an independent package owned by the viewer; it never grants
// access to the source production, package, or arbitrary package-side files.
export function createGuestShowcase({ ledger, store, pipelines, tickets, appPath }) {
  const usable = invite => invite && !['revoked', 'expired'].includes(invite.status);
  function itemFor(viewerId, generation) {
    if (!generation?.showcase || generation.status !== 'ready' || generation.inviteId === viewerId
        || !/^pkg_[a-f0-9]{32}$/.test(generation.packageId ?? '') || !generation.runId
        || !usable(ledger.get(viewerId)) || !usable(ledger.get(generation.inviteId))) return null;
    const run = pipelines.get(generation.runId);
    const productionId = run?.origin?.productionId;
    if (run?.status !== 'completed' || run.packageId !== generation.packageId || !productionId
        || ledger.resourceOwner('package', generation.packageId) !== generation.inviteId
        || ledger.resourceOwner('production', productionId) !== generation.inviteId
        || !run.result?.files?.some(file => file.name === 'video.mp4')) return null;
    return { generation, productionId, run };
  }
  function find(viewerId, packageId) {
    return ledger.listGenerations().slice().reverse().map(row => itemFor(viewerId, row))
      .find(item => item?.generation.packageId === packageId) ?? null;
  }
  function list(viewerId, limit) {
    const rows = ledger.showcase({ excludeInviteId: viewerId, limit });
    const byId = new Map(ledger.listGenerations().map(row => [row.id, row]));
    return rows.filter(row => itemFor(viewerId, byId.get(row.id))).map(row => ({
      ...row, openPath: null,
      openApiPath: `/api/demo/showcase/${encodeURIComponent(row.packageId)}/open`,
    }));
  }
  function copyPackage(viewerId, sourceId) {
    const source = store.read(sourceId);
    if (!source || source.id !== sourceId) throw new Error('shared package unavailable');
    const pkg = structuredClone(source);
    const suffix = randomUUID().replaceAll('-', '');
    pkg.id = `pkg_${suffix}`;
    pkg.revision = 1;
    const sourcePrefix = `assets/guest_${sourceId.slice(4)}/`;
    const sourceRoot = join(store.dir, 'assets', `guest_${sourceId.slice(4)}`);
    const targetRoot = join(store.dir, 'assets', `guest_${suffix}`);
    const copies = new Map();
    function rewrite(holder, allowMissing = false) {
      if (!holder?.file) return;
      const path = holder.file;
      if (typeof path !== 'string' || !path.startsWith(sourcePrefix)
          || !/^[A-Za-z0-9_.-]+$/.test(path.slice(sourcePrefix.length))
          || ['.', '..'].includes(path.slice(sourcePrefix.length))) throw new Error('shared asset unavailable');
      if (!copies.has(path)) {
        const sourceFile = join(sourceRoot, basename(path));
        try {
          const root = realpathSync(sourceRoot);
          const assets = realpathSync(join(store.dir, 'assets'));
          if (!lstatSync(sourceRoot).isDirectory() || root !== join(assets, `guest_${sourceId.slice(4)}`) || !lstatSync(sourceFile).isFile()
              || !realpathSync(sourceFile).startsWith(root + sep)) throw new Error('shared asset unavailable');
          copies.set(path, { sourceFile, name: basename(path) });
        } catch (error) {
          if (allowMissing && error.code === 'ENOENT') copies.set(path, { sourceFile: null, name: basename(path) });
          else throw new Error('shared asset unavailable');
        }
      }
      holder.file = `assets/guest_${suffix}/${copies.get(path).name}`;
    }
    for (const asset of Object.values(pkg.assets ?? {})) {
      rewrite(asset, asset?.status === 'pending');
      for (const variant of Object.values(asset?.variants ?? {})) rewrite(variant, asset?.status === 'pending');
    }
    for (const font of pkg.theme?.fonts ?? []) rewrite(font);
    for (const { sourceFile, name } of copies.values()) {
      if (!sourceFile) continue;
      mkdirSync(targetRoot, { recursive: true, mode: 0o700 });
      copyFileSync(sourceFile, join(targetRoot, name));
    }
    // Bind before publishing the package. Failed writes leave only inert owned
    // IDs and never make the source package accessible to the viewer.
    ledger.bindShowcaseCopy(viewerId, pkg.id);
    return store.write(pkg);
  }
  function open(viewerId, packageId) {
    const item = find(viewerId, packageId);
    if (!item) return null;
    const { generation, productionId, run } = item;
    const video = guestProductionResult({ inviteId: generation.inviteId, productionId, ledger, pipelines, tickets,
      runId: run.runId, authorizeViewer: () => Boolean(find(viewerId, packageId)) });
    if (video?.status !== 'completed') return null;
    const copy = copyPackage(viewerId, packageId);
    return {
      ok: true, packageId: copy.id, prompt: generation.prompt, title: generation.title,
      openPath: `${appPath}?demo=1&mode=super-easy&package=${encodeURIComponent(copy.id)}`,
      mode: 'super-easy', videoUrl: video.url, videoExpiresAt: video.expiresAt,
    };
  }
  return { list, open };
}
