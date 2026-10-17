#!/usr/bin/env node
// Manual live probe. Reads the key from the environment and never prints it.
import { resolveProvider } from '../dist/src/presets.js';
import { probeToolUse } from '../dist/src/probe.js';

const name = process.argv[2] ?? 'opencode-go';
const model = process.argv[3];
const config = resolveProvider(name, { model });
const result = await probeToolUse(config);
console.log(JSON.stringify({ provider: name, ...result }, null, 2));
process.exit(result.ok ? 0 : 1);
