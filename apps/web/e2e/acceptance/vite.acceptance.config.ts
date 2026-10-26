/**
 * Vite config for the acceptance harness only. It wraps the app's own config.
 *
 * Why it exists: `src/easy/steps/index.ts` calls `import.meta.glob('./*.ts', { eager: true })`,
 * which also matches `steps/*.test.ts`. Those files import `node:test`, so in the
 * browser the app throws `TypeError: test is not a function` while loading and the
 * editor never opens (see qa/tests/easy-steps-glob.baseline.test.mjs). That is a
 * product defect outside UX20's remit. This config keeps the harness usable by
 * resolving `node:test` / `node:assert/strict` to inert modules, and only when the
 * importer is a `*.test.ts` file. Application code is untouched. Remove the plugin
 * once the glob stops matching tests.
 */
import { defineConfig, mergeConfig, type Plugin } from 'vite';
import base from '../../vite.config.ts';

const INERT = '\0qa-inert-node-module';

function inertNodeTestModules(): Plugin {
  return {
    name: 'qa-inert-node-test-modules',
    enforce: 'pre',
    resolveId(id, importer) {
      if (importer && /\.test\.ts$/.test(importer) && (id === 'node:test' || id === 'node:assert/strict')) return INERT;
      return null;
    },
    load(id) {
      if (id !== INERT) return null;
      return 'const inert = new Proxy(function () {}, { get: () => inert, apply: () => undefined });\nexport default inert;\n';
    },
  };
}

export default defineConfig(mergeConfig(base, { plugins: [inertNodeTestModules()] }));
