#!/usr/bin/env node
// Live M4 check: one agent session builds/edits a package, routes an icon to SVG
// and an illustration to FLUX, and runs an SVG through A5's sanitize/render/repair loop.
import { resolveProvider } from '../../llm/dist/src/presets.js';
import { createOpenAICompatibleModel } from '../../llm/dist/src/openai-compatible.js';
import { createToolset, runAgent } from '../dist/src/index.js';
import { autoFix, stubGenerator } from '../../vector/dist/src/index.js';

const provider = resolveProvider(process.env.COMFYRIZZ_PROVIDER ?? 'opencode-go', {
  model: process.env.COMFYRIZZ_MODEL,
});
const model = createOpenAICompatibleModel(provider);
const tools = createToolset({
  generateSvg: async intent => {
    const result = await autoFix(stubGenerator, intent, 2, { width: 512 });
    if (!result.ok) throw new Error(result.errors.map(error => `${error.code}: ${error.message}`).join('; '));
    return { svg: result.svg, attempts: result.attempts, repairs: result.repairs, sanitizerVersion: result.sanitizerVersion };
  },
});

const brief = [
  'Build the Orbit launch package. Do it with tools, in this order:',
  '1. storyboard.propose with title "Orbit launch" and brief "A calm agent-shaped desktop".',
  '2. storyboard.edit scene s1 to set copy.headline to "Meet Orbit".',
  '3. assets.route for s1 with kind "icon" and need "rocket icon" (this must be assets.generate_svg).',
  '4. assets.route for s2 with kind "illustration" and need "nebula illustration" (this must be assets.generate_image).',
  'Do not generate the assets; just route them. Then summarize in one sentence.',
].join('\n');

const events = [];
const result = await runAgent({
  model,
  brief,
  tools,
  sessionId: 'm4-live',
  maxSteps: 10,
  onEvent: event => {
    events.push(event);
    if (event.type === 'step') process.stderr.write(`step ${event.step}\n`);
    if (event.type === 'tool_call') process.stderr.write(`  call ${event.name}\n`);
    if (event.type === 'error') process.stderr.write(`  error ${event.code}\n`);
  },
});
const calls = result.toolCalls.map(call => ({ name: call.name, ok: call.ok, error: call.error }));
const routes = result.toolCalls.filter(call => call.name === 'assets.route' && call.ok).map(call => call.result);
const svgCall = result.toolCalls.find(call => call.name === 'assets.generate_svg');
if (!svgCall) {
  const generated = await tools['assets.generate_svg'].run({ scene_id: 's1', kind: 'icon', intent: 'rocket icon', palette: ['#0d0f14', '#6d8cff'] });
  result.toolCalls.push({ id: 'manual-svg', name: 'assets.generate_svg', args: {}, ok: true, result: generated });
}
const summary = {
  provider: provider.name,
  model: provider.model,
  ok: result.ok,
  stopped: result.stopped,
  text: result.text,
  calls: result.toolCalls.map(call => call.name),
  routes: routes.map(route => route.tool),
  packageTitle: result.toolCalls.find(call => call.name === 'storyboard.propose')?.result?.package?.title,
  finalHeadline: result.toolCalls.find(call => call.name === 'storyboard.edit')?.result?.package?.scenes?.[0]?.copy?.headline,
  svg: result.toolCalls.find(call => call.name === 'assets.generate_svg')?.result?.asset ? {
    generator: result.toolCalls.find(call => call.name === 'assets.generate_svg').result.asset.generator,
    repairs: result.toolCalls.find(call => call.name === 'assets.generate_svg').result.pipeline.repairs,
    bytes: result.toolCalls.find(call => call.name === 'assets.generate_svg').result.asset.bytes,
  } : null,
  events,
  callsDetail: calls,
  error: result.error,
};
console.log(JSON.stringify(summary, null, 2));
const routesOk = summary.routes.includes('assets.generate_svg') && summary.routes.includes('assets.generate_image');
process.exit(result.ok && routesOk && summary.finalHeadline === 'Meet Orbit' ? 0 : 1);
