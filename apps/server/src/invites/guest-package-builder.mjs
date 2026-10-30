// Build guest packages with a fresh isolated agent workspace. The offline
// agent derives package and asset IDs deterministically, so using its shared
// defaults would allow two guests with the same prompt to overwrite each
// other's package and generated files.
import { randomUUID } from 'node:crypto';
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createCpuAgentRunner } from '../agent-runner.mjs';

export function createGuestPackageBuilder({ runtimeDir, store, ledger, runnerFactory = createCpuAgentRunner } = {}) {
  if (!runtimeDir || !store || !ledger) throw new TypeError('guest package builder requires runtime, store and ledger');
  return async function build({ inviteId, brief } = {}) {
    if (typeof brief !== 'string' || brief.trim() === '') throw new TypeError('brief is required');
    const invite = ledger.get(inviteId);
    if (!invite || invite.status !== 'active') throw new Error('invite not active');
    const stagingRoot = join(runtimeDir, 'guest-builds');
    mkdirSync(stagingRoot, { recursive: true, mode: 0o700 });
    const staging = mkdtempSync(join(stagingRoot, 'build-'));
    try {
      // Do not pass a client-controlled provider, session, brand, or event
      // callback. The default offline runner never contacts an LLM provider.
      const result = await runnerFactory({ runtimeDir: staging })({ brief });
      const pkg = structuredClone(result.package);
      // The offline agent records image plans without attaching them to its
      // CPU fallback scenes. Attach only server-produced planned images so
      // Colab planning can account for the work and the result can be used.
      for (const pending of result.pendingGpu ?? []) {
        const scene = pkg.scenes?.find(item => item.id === pending.sceneId);
        const asset = pkg.assets?.[pending.assetId];
        if (!scene || asset?.kind !== 'image' || asset?.status !== 'pending') {
          throw new Error('guest image plan has no valid scene');
        }
        if (!Array.isArray(scene.foreground)) scene.foreground = [];
        if (!scene.foreground.some(item => item.asset === pending.assetId)) {
          scene.foreground.unshift({ asset: pending.assetId, x: 0.5, y: 0.5, w: 1, anim: 'fade-in' });
        }
      }
      const suffix = randomUUID().replaceAll('-', '');
      pkg.id = `pkg_${suffix}`;
      if (store.read(pkg.id) || ledger.resourceOwner('package', pkg.id)) throw new Error('package id collision');
      const assetDir = join(store.dir, 'assets', `guest_${suffix}`);
      for (const asset of Object.values(pkg.assets ?? {})) {
        if (!asset?.file) continue;
        if (typeof asset.file !== 'string' || !/^assets\/[A-Za-z0-9_.-]+$/.test(asset.file)) {
          throw new Error('guest asset path is invalid');
        }
        const source = join(staging, 'packages', asset.file);
        if (!lstatSync(source).isFile()) throw new Error('guest asset is not a regular file');
        mkdirSync(assetDir, { recursive: true, mode: 0o700 });
        copyFileSync(source, join(assetDir, basename(asset.file)));
        asset.file = `assets/guest_${suffix}/${basename(asset.file)}`;
      }
      // Bind before the package can be returned. A failed write may leave an
      // inert mapping, never a visible unowned package.
      ledger.bindResource(inviteId, 'package', pkg.id);
      const saved = store.write(pkg);
      return { ...result, package: saved };
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  };
}
