// C5: the default CPU agent runner. It wires packages/agent + packages/llm +
// packages/vector. Offline it uses the deterministic scripted model; with a
// provider it uses the live model for both planning and SVG markup, falling
// back to the A5 stub if the model output cannot be parsed.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inlineGeneratedAssets } from '../../renderer/scripts/render-package-lib.mjs';
import { validatePackage } from '../../../packages/schema/src/index.mjs';

const SVG_SYSTEM = [
  'You write one standalone SVG document and nothing else.',
  'Use an <svg> root with a viewBox, only the supplied palette colours, and no <script>, <image>, external references or event attributes.',
  'Prefer simple shapes and paths. Keep it under 4 KB.',
].join(' ');

function extractSvg(text) {
  const match = /<svg[\s\S]*?<\/svg>/i.exec(text);
  return match ? match[0] : null;
}

function createLlmSvgGenerator(model, sessionId) {
  return async ({ intent, attempt, errors }) => {
    const prompt = [
      `Draw a ${intent.kind} SVG for: ${intent.prompt}`,
      intent.palette?.length ? `Palette: ${intent.palette.join(', ')}.` : '',
      attempt > 1 && errors.length ? `The previous attempt failed: ${errors.map(error => error.message).join('; ')}. Fix it.` : '',
    ].filter(Boolean).join('\n');
    let text = '';
    for await (const chunk of model.stream({
      system: SVG_SYSTEM,
      messages: [{ role: 'user', content: prompt }],
      tools: [],
      signal: new AbortController().signal,
      sessionId,
    })) {
      if (chunk.type === 'text') text += chunk.delta;
      if (chunk.type === 'error') throw new Error(`${chunk.code}${chunk.message ? `: ${chunk.message}` : ''}`);
    }
    const svg = extractSvg(text);
    if (!svg) throw new Error('model did not return an <svg> document');
    return svg;
  };
}

export function createCpuAgentRunner({ runtimeDir, now = () => new Date().toISOString() } = {}) {
  const packagesDir = join(runtimeDir, 'packages');
  const assetsDir = join(packagesDir, 'assets');
  return async function runCpuAgent({ brief, provider, model: modelName, sessionId = 'cpu-slice', onEvent } = {}) {
    if (typeof brief !== 'string' || brief.trim().length === 0) {
      const error = new Error('brief is required');
      error.status = 400;
      throw error;
    }
    const { runCpuSlice } = await import('../../../packages/agent/dist/src/index.js');
    const vector = await import('../../../packages/vector/dist/src/index.js');
    let agentModel;
    let live = false;
    let resolved;
    if (provider) {
      const { resolveProvider } = await import('../../../packages/llm/dist/src/index.js');
      const { createOpenAICompatibleModel } = await import('../../../packages/llm/dist/src/index.js');
      resolved = resolveProvider(provider, modelName ? { model: modelName } : {});
      agentModel = createOpenAICompatibleModel(resolved);
      live = true;
    }
    const persistSvg = (assetId, svg) => {
      mkdirSync(assetsDir, { recursive: true });
      writeFileSync(join(assetsDir, `${assetId}.svg`), svg);
      return `assets/${assetId}.svg`;
    };
    const generateSvg = async intent => {
      const llmGenerator = live ? createLlmSvgGenerator(agentModel, `${sessionId}-svg`) : null;
      let result;
      let source = 'stub';
      if (llmGenerator) {
        try {
          const attempt = await vector.autoFix(llmGenerator, intent, 2, { width: 512 });
          if (attempt.ok) {
            result = attempt;
            source = 'llm';
          }
        } catch {
          // fall through to the deterministic stub
        }
      }
      if (!result) {
        result = await vector.autoFix(vector.stubGenerator, intent, 2, { width: 512 });
        source = 'stub';
      }
      if (!result.ok) throw new Error(result.errors.map(error => `${error.code}: ${error.message}`).join('; '));
      const check = vector.renderCheck(result.svg, { width: 512, palette: intent.palette });
      return {
        svg: result.svg,
        attempts: result.attempts,
        repairs: result.repairs,
        source,
        sanitizerVersion: result.sanitizerVersion,
        renderCheck: {
          ok: check.ok,
          version: result.sanitizerVersion,
          width: check.width,
          height: check.height,
          opaqueFraction: check.opaqueFraction,
          outOfPaletteFraction: check.outOfPaletteFraction,
        },
      };
    };
    const runOnce = model =>
      runCpuSlice({
        brief,
        ...(model ? { model } : {}),
        generateSvg,
        persistSvg,
        sessionId,
        now,
        ...(onEvent ? { onEvent } : {}),
      });
    const acceptable = candidate =>
      candidate.svgAssets.length >= 4 && candidate.pendingGpu.length >= 1 && validatePackage(candidate.package).valid;
    let slice = await runOnce(agentModel);
    // A live model can stall, stop early, or invent fields the v1 schema rejects.
    // Fall back to the deterministic plan (still using the live SVG generator)
    // so the CPU slice always completes with a valid package.
    if (agentModel && !acceptable(slice)) {
      slice = await runOnce(null);
    }
    const validation = validatePackage(slice.package);
    if (!validation.valid) {
      const error = new Error('agent produced an invalid package');
      error.errors = validation.errors;
      throw error;
    }
    const generatedAssets = inlineGeneratedAssets(slice.package, packagesDir);
    return {
      ok: slice.ok,
      live,
      provider: resolved?.name ?? 'scripted',
      model: resolved?.model ?? 'scripted',
      package: slice.package,
      timeline: null,
      generatedAssets,
      routes: slice.routes,
      pendingGpu: slice.pendingGpu,
      svgAssets: slice.svgAssets,
      events: slice.result.toolCalls.map(call => ({ name: call.name, ok: call.ok })),
    };
  };
}
