import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createOpenAICompatibleModel } from '@comfyrizz/llm';
import { adoptSuppliedFont } from '../../../apps/server/src/supplied-font.mjs';
import { ROOT, runTitle, readJson, atomicJson, hash } from '../src/runner.mjs';
import { WIDTH_TARGET, measureTitle, decodeRgb, analyzeTitlePixels } from '../src/title-measurement.mjs';
import { cpuRender } from '../src/cpu-render.mjs';

test('OFFLINE actual Anton rendered-width failure → one Pi correction → measured pass, plus wrong-font control', {
  skip: !process.env.PI_TITLE_VISUAL_EVIDENCE, timeout: 360000,
}, async () => {
  const dir = resolve(process.env.PI_TITLE_VISUAL_EVIDENCE); mkdirSync(dir, { recursive: true });
  const fontRuntime = process.env.PI_TITLE_FONT_RUNTIME;
  const fontConversation = process.env.PI_TITLE_FONT_CONVERSATION;
  assert.ok(fontRuntime && fontConversation, 'Explicit authorized font record required');
  const fonts = adoptSuppliedFont({ runtimeDir: fontRuntime, conversationId: fontConversation, package: { theme: {} }, assetsDir: join(dir, 'assets') }).theme.fonts;
  const fixture = readJson(join(ROOT, 'docs/submission/super-easy-reduced-briefs.json')).briefs.find(b => b.id === 'title-simple-12');
  const brief = { ...fixture, exactText: 'PLEASE HOLD', revealSeconds: 3, titleWidth: WIDTH_TARGET };
  let calls = 0;
  const model = createOpenAICompatibleModel({ name: 'OFFLINE-HTTP', model: 'OFFLINE-TEST-NOT-MODEL-QUALITY', baseUrl: 'https://test.invalid/v1', headers: {}, apiKey: null,
    thinking: 'disabled', reasoningEffort: 'low', maxTokens: 8192, maxRetries: 0,
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body); calls++;
      assert.ok(calls <= 2); assert.ok(body.tools.length);
      atomicJson(join(dir, `offline-wire-${calls}.json`), body);
      const user = JSON.parse(body.messages.find(message => message.role === 'user').content);
      let name, args;
      if (calls === 1) {
        assert.equal(body.tools[0].function.parameters.properties.theme.properties.font.enum[0], fonts[0].family);
        name = 'storyboard_propose';
        args = { brief: fixture.prompt, title: 'OFFLINE VISUAL FIXTURE', theme: { palette: ['#f4efe6', '#111111', '#1f4fd8', '#111111'], text: '#111111' },
          scenes: [{ id: 's1', layout: 'title', copy: { headline: 'PLEASE\nHOLD' }, headline_size: 150, preferredFrames: 360, motion: { entry: 'none' }, transitionOut: { type: 'cut', frames: 0 } }] };
      } else {
        const finding = user.findings.items.find(item => item.code === 'rendered-title-width');
        assert.equal(finding.status, 'fail'); assert.ok(finding.metrics.widthFraction > 0.18 && finding.metrics.widthFraction < 0.22);
        assert.ok(finding.recommendedSize >= 420 && finding.recommendedSize <= 470);
        name = 'storyboard_edit'; args = { scene_id: 's1', patch: { headline_size: finding.recommendedSize } };
      }
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: `offline-${calls}`, function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
    } });
  const result = await runTitle({ dir, brief, fonts, mode: 'live', chatModel: model, timeoutMs: 300000, config: { provider: 'OFFLINE-TEST-NO-NETWORK', model: model.id, thinking: 'disabled', maxTokens: 8192 } });
  const measured = result.findings.items.find(item => item.code === 'rendered-title-width');
  assert.equal(measured.status, 'pass'); assert.equal(measured.metrics.bands.length, 2);
  assert.equal(calls, 2); assert.equal(result.repairCalls, 1);
  assert.equal(result.export.audit.allHold.pass, true);
  assert.equal(result.export.audit.finalFrameAgreement.pass, true);
  const before = readJson(join(dir, 'pre-correction-package.json')), after = structuredClone(result.package);
  after.revision = before.revision; after.scenes[0].headline_size = before.scenes[0].headline_size;
  assert.deepEqual(after, before, 'Only size/revision may change');
  await runTitle({ dir, mode: 'resume', chatModel: model }); assert.equal(calls, 2);
  // Independent same-renderer reference at the known ~440px scale, not a model
  // hint or replacement film. Keep it separate from the exported package.
  const control = structuredClone(result.package); control.scenes[0].headline_size = 440;
  atomicJson(join(dir, 'reference440.json'), control);
  await cpuRender(join(dir, 'reference440.json'), join(dir, 'reference440.png'), { still: true, frame: 359, scale: 0.5 });
  const controlState = { ...result, package: control };
  const reference = await measureTitle({ state: controlState, dir, sample: { file: 'reference440.png', frame: 359, scale: 0.5 }, signal: AbortSignal.timeout(90000) });
  assert.equal(reference.status, 'pass');
  // Wrong-rendered-font control: compare an actual Inter composited frame to
  // the Anton diagnostics; reconstruction must reject this mismatch.
  const wrongFont = structuredClone(control); wrongFont.theme.font = 'Inter'; delete wrongFont.theme.fonts;
  atomicJson(join(dir, 'wrong-font-control.json'), wrongFont);
  await cpuRender(join(dir, 'wrong-font-control.json'), join(dir, 'wrong-font-control.png'), { still: true, frame: 359, scale: 0.5 });
  const signal = AbortSignal.timeout(60000);
  const original = await decodeRgb(join(dir, 'wrong-font-control.png'), signal);
  const black = await decodeRgb(join(dir, reference.artifacts[0].file), signal);
  const white = await decodeRgb(join(dir, reference.artifacts[1].file), signal);
  const wrong = analyzeTitlePixels({ original, black, white, textRgb: [17, 17, 17], backgroundRgb: [244, 239, 230], compositionWidth: 1920, compositionHeight: 1080, expectedLines: 2 }).metrics;
  assert.equal(wrong.compositedAgreement.pass, false);
  atomicJson(join(dir, 'OFFLINE-VISUAL-REPORT.json'), { provenance: 'TEST-ONLY scripted HTTP responses; zero network; real Pi/native renderer/measurements', calls, beforeSize: 150, afterSize: result.package.scenes[0].headline_size,
    corrected: measured, reference440: reference, wrongRenderedFont: wrong, export: result.export, packageFileUnchangedByDiagnostics: hash(readJson(join(dir, 'package.json'))) === hash(result.package) });
});
