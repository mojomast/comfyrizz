// Select the already-reviewed FastH3 pin when a package contains pending H3 jobs.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function packageModelLock({ packageDir, scratchDir, repo, defaultLock }) {
  const file = packageDir && join(packageDir, 'package.json');
  if (!file || !existsSync(file)) return defaultLock;
  const pkg = JSON.parse(readFileSync(file, 'utf8'));
  const pending = Object.values(pkg.assets ?? {}).filter(a => a.origin === 'generated' && !['ready', 'candidate', 'rejected'].includes(a.status));
  if (!pending.some(a => a.gen?.generator === 'fasth3-omni')) return defaultLock;
  const standard = JSON.parse(readFileSync(defaultLock, 'utf8'));
  const h3 = JSON.parse(readFileSync(join(repo, 'colab/fasth3-models.lock.json'), 'utf8'));
  const needsLtx = pending.some(a => ['ltx25', 'ltx25-a2v'].includes(a.gen?.generator));
  const hosts = Object.fromEntries(Object.entries(standard.hosts).filter(([name]) => needsLtx || name !== 'ltx'));
  const lock = { ...standard, purpose: 'Package-selected FastH3 Omni + Klein profile; native pilot pins.',
    hosts: { ...hosts, ...h3.hosts },
    files: [...standard.files.filter(f => hosts[f.host]), ...h3.files],
    merge: (standard.merge ?? []).filter(m => hosts[m.host]),
    comfyui: { ...standard.comfyui, revision: h3.comfyuiRevision },
    requiredNodes: ['MiniMaxH3ReferenceToVideo', 'MiniMaxH3SigmaShift', 'BlockSparseAttention', 'VAEDecodeAudio', 'CreateVideo', 'SaveVideo'],
  };
  const path = join(scratchDir, 'package-models.lock.json');
  writeFileSync(path, JSON.stringify(lock, null, 2));
  return path;
}

// Pilot selected takes: approximately 54–66 s for 5–6 s of native video.
// Round up to 13 wall seconds/source second, with a one-minute per-job floor.
export function fasth3JobMinutes(job) {
  const seconds = Number(job.frames ?? job.params?.frames ?? 124) / Number(job.fps ?? job.params?.fps ?? 24);
  return Math.max(1, seconds * 13 / 60);
}
