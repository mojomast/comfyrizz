// Config for the GPU-test-2 showcase composition (lives outside apps/renderer, reuses its code).
// Bare imports resolve through ./node_modules, a symlink to apps/renderer/node_modules made by render.sh.
import path from 'node:path';
import { Config } from '@remotion/cli/config';

const rendererModules = path.resolve(process.cwd(), 'node_modules');
Config.setOverwriteOutput(true);
Config.setCodec('h264');
Config.setPixelFormat('yuv420p');
Config.setConcurrency(4);
Config.overrideWebpackConfig(current => ({
  ...current,
  resolve: { ...current.resolve, modules: [rendererModules, 'node_modules'] },
}));
