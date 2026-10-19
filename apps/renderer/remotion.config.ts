import { Config } from '@remotion/cli/config';

// Pinned, offline render settings (spec 6.9).
Config.setOverwriteOutput(true);
Config.setCodec('h264');
Config.setPixelFormat('yuv420p');
Config.setColorSpace('bt709');
// Under a loaded box (the whole workspace testing in parallel) Chrome setup can
// take longer than the 30 s default; a longer ceiling does not slow a fast render.
Config.setDelayRenderTimeoutInMilliseconds(120_000);
Config.setConcurrency(2);
