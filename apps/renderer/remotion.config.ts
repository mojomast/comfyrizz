import { Config } from '@remotion/cli/config';

// Pinned, offline render settings (spec 6.9).
Config.setOverwriteOutput(true);
Config.setCodec('h264');
Config.setPixelFormat('yuv420p');
Config.setColorSpace('bt709');
Config.setConcurrency(2);
