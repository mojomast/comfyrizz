const DIST_PACKAGES = ['vector', 'planner', 'llm', 'agent', 'sources', 'tts'];

export const PRETEST_PACKAGES = DIST_PACKAGES;

export function createChecks(rootDir) {
  const checks = [];
  checks.push({
    id: 'repo-node-modules',
    title: 'node_modules present',
    async run({ fs }) {
      const exists = await fs.exists(`${rootDir}/node_modules`);
      return { status: exists ? 'ok' : 'fail', detail: exists ? 'node_modules present' : 'node_modules missing', fix: exists ? '' : 'pnpm install --frozen-lockfile' };
    },
  });
  checks.push({
    id: 'repo-pnpm-lock',
    title: 'pnpm-lock.yaml present',
    async run({ fs }) {
      const exists = await fs.exists(`${rootDir}/pnpm-lock.yaml`);
      return { status: exists ? 'ok' : 'fail', detail: exists ? 'pnpm-lock.yaml present' : 'pnpm-lock.yaml missing', fix: exists ? '' : 'pnpm install --frozen-lockfile' };
    },
  });
  checks.push({
    id: 'repo-venv',
    title: '.venv present',
    async run({ fs }) {
      const exists = await fs.exists(`${rootDir}/.venv`);
      return { status: exists ? 'ok' : 'warn', detail: exists ? '.venv present' : '.venv missing', fix: exists ? '' : 'uv venv .venv -p 3.12' };
    },
  });
  for (const pkg of DIST_PACKAGES) {
    checks.push({
      id: `repo-dist-${pkg}`,
      title: `dist built: ${pkg}`,
      async run({ fs }) {
        const exists = await fs.exists(`${rootDir}/packages/${pkg}/dist`);
        return { status: exists ? 'ok' : 'warn', detail: exists ? `packages/${pkg}/dist present` : `packages/${pkg}/dist missing`, fix: exists ? '' : `npm --prefix packages/${pkg} run build` };
      },
    });
  }
  return checks;
}

export default createChecks;
