import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runAgent } from '../src/agent.js';
import {
  STYLE_PRESET_ENERGY,
  critiqueRubricPrompt,
  motionSystemSection,
  motionVocabulary,
  parseCritiqueReply,
  providerDeclaresImageInput,
  runMotionCritique,
} from '../src/prompts/motion.js';
import { createToolset } from '../src/tools.js';
import type { ChatChunk, ChatModel, ChatRequest } from '../src/types.js';

const schema = JSON.parse(readFileSync(new URL('../../../schema/package-v1.schema.json', import.meta.url), 'utf8'));

function defEnum(defName: string, prop?: string): string[] {
  const def = schema.$defs[defName] as { enum?: string[]; $ref?: string; properties?: Record<string, { enum?: string[]; $ref?: string }> };
  const node = prop ? def.properties?.[prop] : def;
  if (!node) throw new Error(`missing schema node ${defName}`);
  if (Array.isArray(node.enum)) return node.enum;
  const target = node.$ref?.split('/').pop();
  if (!target) throw new Error(`missing schema enum ${defName}`);
  return (schema.$defs[target] as { enum: string[] }).enum;
}

class RecordingModel implements ChatModel {
  id: string;
  imageInput?: boolean;
  requests: ChatRequest[] = [];
  constructor(private handler: (step: number, request: ChatRequest) => ChatChunk[], id = 'scripted', imageInput?: boolean) {
    this.id = id;
    this.imageInput = imageInput;
  }
  async *stream(request: ChatRequest): AsyncIterable<ChatChunk> {
    this.requests.push(request);
    const chunks = this.handler(this.requests.length - 1, request);
    for (const chunk of chunks) yield chunk;
  }
}

test('motion prompt lists the schema enums and the shot-list rules', () => {
  const prompt = motionSystemSection();
  const vocab = motionVocabulary();
  const groups: Array<[string, string[]]> = [
    ['motion.energy', defEnum('motionEnergy')],
    ["motion.direction, the film's one current", defEnum('motionDirection')],
    ['scenes[].motion.entry', defEnum('sceneMotion', 'entry')],
    ['scenes[].motion.ease', defEnum('easingToken')],
    ['scenes[].motion.spring', defEnum('springPreset')],
    ['scenes[].motion.stagger', defEnum('sceneMotion', 'stagger')],
    ['scenes[].motion.emphasis', defEnum('sceneMotion', 'emphasis')],
    ['transitionOut.type', defEnum('transitionType')],
    ['transitionOut.direction', defEnum('transitionDirection')],
  ];
  for (const [label, values] of groups) {
    assert.ok(values.length > 1, label);
    assert.ok(prompt.includes(`${label}: ${values.join(' | ')}`), `${label} is missing from the prompt`);
    assert.deepEqual(
      label.startsWith('motion.energy') ? [...vocab.energies]
        : label.includes('direction,') ? [...vocab.directions]
          : label.endsWith('entry') ? [...vocab.entries]
            : label.endsWith('ease') ? [...vocab.easing]
              : label.endsWith('spring') ? [...vocab.springs]
                : label.endsWith('stagger') ? [...vocab.staggers]
                  : label.endsWith('emphasis') ? [...vocab.emphasis]
                    : label.endsWith('type') ? [...vocab.transitionTypes]
                      : [...vocab.transitionDirections],
      values,
      `${label} drifted from the schema`,
    );
  }
  assert.match(prompt, /never write animation code/i);
  assert.match(prompt, /Length and format/);
  assert.match(prompt, /one accent/);
  assert.match(prompt, /Beats in order/);
  assert.match(prompt, /Motion verbs/);
  assert.match(prompt, /Final hold/);
  assert.match(prompt, /One focal point per frame/);
  assert.match(prompt, /2-3 transition types/);
  assert.match(prompt, /One primary type/);
  assert.match(prompt, /One current direction/);
  assert.match(prompt, /One hero moment/);
  assert.match(prompt, /0\.3-0\.75 s/);
  assert.match(prompt, /No idle wobble/);
  assert.match(prompt, /Exits are faster than entries/);
  assert.match(prompt, /Example data/);
  assert.equal(prompt.includes('Colab'), false);
  for (const preset of Object.keys(STYLE_PRESET_ENERGY)) {
    const energy = STYLE_PRESET_ENERGY[preset as keyof typeof STYLE_PRESET_ENERGY];
    assert.ok(defEnum('motionEnergy').includes(energy), energy);
    assert.ok(prompt.includes(`${preset} → ${energy}`), preset);
  }
});

test('motion prompt uses the shared recipe IDs and recommended layouts', async () => {
  const prompt = motionSystemSection();
  const { ANIMATION_RECIPES } = await import(new URL('../../../schema/src/animation.mjs', import.meta.url).href);
  assert.ok(ANIMATION_RECIPES.length > 0);
  for (const recipe of ANIMATION_RECIPES) {
    assert.ok(prompt.includes(`- ${recipe.id}: ${recipe.layouts.join(', ')}`), `${recipe.id} layouts drifted from the catalogue`);
  }
  assert.match(prompt, /process or cause\/effect → technical-flow/);
  assert.match(prompt, /mechanism → sketch/);
  assert.match(prompt, /before\/after → morph or a compare layout/);
  assert.match(prompt, /evidence\/detail → focus/);
  assert.match(prompt, /hook\/chapter\/conclusion → kinetic/);
});

test('motion prompt bounds diagram, focus, and morph fields', () => {
  const prompt = motionSystemSection();
  assert.match(prompt, /scenes\[\]\.motion\.diagram: flow \| hub/);
  assert.ok(prompt.includes('focus is {x,y,width,height}'));
  assert.ok(prompt.includes('x + width <= 1 and y + height <= 1'));
  assert.ok(prompt.includes('morph is {from,to} using circle | square | triangle | blob only'));
  assert.match(prompt, /not arbitrary media/);
});

test('motion prompt keeps narration cues exact and explicit seconds authoritative', () => {
  const prompt = motionSystemSection();
  assert.match(prompt, /cue_phrases contains up to 6 exact phrases copied from that scene's narration in spoken order/);
  assert.match(prompt, /never invent alignment/);
  assert.match(prompt, /cue_seconds take precedence over cue_phrases/);
  assert.match(prompt, /clear stale seconds when switching to phrases/);
});

test('motion prompt separates full typography from media-only footage', () => {
  const prompt = motionSystemSection();
  assert.match(prompt, /native, editable Remotion copy/);
  assert.match(prompt, /never lettering baked into AI-generated pixels/);
  assert.match(prompt, /Full typography requires media_only:false/);
  assert.match(prompt, /media_only:true is for footage plus lower thirds\/non-text decor/);
});

test('motion prompt defaults to cuts and forbids a final outgoing transition', () => {
  const prompt = motionSystemSection();
  assert.match(prompt, /Hard cuts \(cut, 0 frames\) are the default/);
  assert.match(prompt, /actual final scene in scenes\[\] has no outgoing transition/);
  assert.match(prompt, /never give it a positive-duration transition/);
  assert.match(prompt, /One expressive gesture per scene/);
});

test('a scripted brief produces motion fields that lint with zero errors', async () => {
  const { lintMotion } = await import(new URL('../../../schema/src/motion.mjs', import.meta.url).href);
  const { validatePackage } = await import(new URL('../../../schema/src/index.mjs', import.meta.url).href);
  const tools = createToolset();
  const brief = 'A 45 second 16:9 explainer for students. Look: editorial-flat, one accent on the number. Length 45 s.';
  const model = new RecordingModel(step => {
    if (step === 0) {
      return [{
        type: 'tool_call',
        id: 'propose',
        name: 'storyboard.propose',
        args: {
          brief,
          title: 'Plants store sunlight',
          motion: { energy: 'medium', direction: 'left' },
          datasets: {
            d_yield: {
              unit: 'units',
              label: 'Example data',
              values: [{ label: 'Example', value: 42 }],
              source: 'example',
              approved: true,
              note: 'Example data',
            },
          },
          scenes: [
            {
              id: 's_hook',
              layout: 'title',
              variant: 'centered',
              preferredFrames: 150,
              copy: { headline: 'Plants store sunlight', sub: 'A short explainer' },
              motion: { entry: 'maskRise', ease: 'enter', stagger: 'word', emphasis: 'none' },
              transitionOut: { type: 'push', frames: 12, direction: 'left' },
            },
            {
              id: 's_point',
              layout: 'hero',
              variant: 'split',
              preferredFrames: 180,
              copy: { headline: 'Leaves make sugar', sub: 'The point of the film' },
              motion: { entry: 'fadeUp', ease: 'enter', emphasis: 'keyword', highlight: 'sugar' },
              transitionOut: { type: 'push', frames: 12, direction: 'left' },
            },
            {
              id: 's_proof',
              layout: 'stat',
              preferredFrames: 210,
              copy: { headline: 'Example yield', sub: 'Example data', body: '42' },
              data: { dataset: 'd_yield', display: 'number' },
              motion: { entry: 'countUp', ease: 'land', spring: 'pop', emphasis: 'hero' },
              transitionOut: { type: 'fade', frames: 15 },
            },
            {
              id: 's_cta',
              layout: 'title',
              variant: 'outro',
              preferredFrames: 150,
              copy: { headline: 'Look it up', sub: 'Hold the final frame' },
              motion: { entry: 'fadeUp', ease: 'enter', emphasis: 'none' },
            },
          ],
        },
      }];
    }
    return [{ type: 'text', delta: 'Package ready.' }];
  });
  const result = await runAgent({ model, brief, tools, maxSteps: 4 });
  assert.equal(result.ok, true, result.error);
  const system = model.requests[0].system;
  assert.ok(system.includes(`motion.energy: ${defEnum('motionEnergy').join(' | ')}`));
  assert.match(system, /You are Comfyrizz, a video-package agent/);
  const pkg = (result.toolCalls[0].result as { package: any }).package;
  assert.equal(pkg.motion.energy, 'medium');
  assert.equal(pkg.motion.direction, 'left');
  assert.equal(pkg.scenes[0].motion.entry, 'maskRise');
  assert.equal(pkg.scenes[1].motion.highlight, 'sugar');
  assert.equal(pkg.scenes[2].motion.entry, 'countUp');
  assert.equal(pkg.scenes[2].motion.emphasis, 'hero');
  assert.equal(pkg.scenes[2].transitionOut.type, 'fade');
  assert.equal(pkg.scenes[0].transitionOut.direction, 'left');
  assert.equal((result.toolCalls[0].result as { motion_fixes?: unknown }).motion_fixes, undefined);
  const findings = lintMotion(pkg).filter((finding: { severity: string }) => finding.severity === 'error' || finding.severity === 'warning');
  assert.deepEqual(findings, [], JSON.stringify(lintMotion(pkg), null, 2));
  const validation = validatePackage(pkg);
  assert.equal(validation.valid, true, JSON.stringify(validation.errors, null, 2));
});

test('unknown motion tokens are dropped and motion stays on the scene', async () => {
  const tools = createToolset();
  const proposed = await tools['storyboard.propose'].run({
    brief: 'A short film',
    title: 'Short',
    scenes: [{
      id: 's_title',
      layout: 'title',
      variant: 'centered',
      motion: { entry: 'wiggle', ease: 'enter', emphasis: 'none' },
      transitionOut: { type: 'spin', frames: 10, direction: 'left' },
    }, {
      id: 's_tail', layout: 'hero', preferredFrames: 90, copy: { headline: 'Closing' },
    }],
  }) as { package: any };
  assert.equal(proposed.package.scenes[0].motion.ease, 'enter');
  assert.equal(proposed.package.scenes[0].motion.entry, 'maskRise', 'the invalid token falls back to the opener default');
  assert.equal(proposed.package.scenes[0].transitionOut, undefined);
  const edited = await tools['storyboard.edit'].run({
    scene_id: 's_title',
    patch: { motion: { entry: 'fadeUp' }, transitionOut: { type: 'push', frames: 12, direction: 'left' } },
  }) as { package: any };
  assert.equal(edited.package.scenes[0].motion.ease, 'enter');
  assert.equal(edited.package.scenes[0].motion.entry, 'fadeUp');
  assert.equal(edited.package.scenes[0].transitionOut.type, 'push');
});

test('a bad package yields fix instructions and the next scripted turn passes', async () => {
  const { lintMotion } = await import(new URL('../../../schema/src/motion.mjs', import.meta.url).href);
  const { validatePackage } = await import(new URL('../../../schema/src/index.mjs', import.meta.url).href);
  const tools = createToolset();
  const point = (id: string, transitionOut: Record<string, unknown>) => ({
    id,
    layout: 'hero',
    variant: 'split',
    preferredFrames: 180,
    copy: { headline: 'Next point here' },
    motion: { entry: 'fadeUp', ease: 'enter', emphasis: 'none' },
    transitionOut,
  });
  const badArgs = {
    brief: 'A film that uses too many transitions and rushes the ending.',
    title: 'Rushed ending',
    motion: { energy: 'medium', direction: 'left' },
    scenes: [
      point('s_a', { type: 'fade', frames: 15 }),
      point('s_b', { type: 'blur', frames: 18 }),
      point('s_c', { type: 'slide', frames: 12, direction: 'left' }),
      point('s_d', { type: 'push', frames: 12, direction: 'left' }),
      point('s_e', { type: 'zoom', frames: 9, direction: 'in' }),
      {
        id: 's_end',
        layout: 'title',
        variant: 'outro',
        preferredFrames: 15,
        copy: { headline: 'Remember this' },
        motion: { entry: 'none', ease: 'enter', emphasis: 'none' },
      },
    ],
  };
  let badSnapshot: unknown;
  const model = new RecordingModel((step, request) => {
    if (step === 0) return [{ type: 'tool_call', id: 'bad', name: 'storyboard.propose', args: badArgs }];
    if (step === 1) {
      const tool = request.messages.filter(message => message.role === 'tool').at(-1);
      assert.ok(tool && tool.role === 'tool');
      const body = JSON.parse(tool.content);
      badSnapshot = structuredClone(body.package);
      const fixes = body.motion_fixes as Array<{ tool: string; args: unknown; text: string; code: string }>;
      const text = fixes.map(fix => fix.text).join('\n');
      assert.match(text, /5 transition types/);
      assert.match(text, /0\.50 s/);
      assert.ok(fixes.every(fix => fix.tool === 'storyboard.edit'));
      assert.deepEqual(
        fixes.map(fix => fix.code).sort(),
        ['MOTION_FINAL_HOLD', 'MOTION_TRANSITION_BUDGET', 'MOTION_TRANSITION_BUDGET'],
      );
      return fixes.map((fix, index) => ({ type: 'tool_call' as const, id: `fix_${index}`, name: fix.tool, args: fix.args }));
    }
    return [{ type: 'text', delta: 'Motion fixed.' }];
  });
  const result = await runAgent({ model, brief: badArgs.brief, tools, maxSteps: 4 });
  assert.equal(result.ok, true, result.error);
  const before = lintMotion(badSnapshot);
  assert.ok(before.some((finding: { code: string }) => finding.code === 'MOTION_TRANSITION_BUDGET'));
  assert.ok(before.some((finding: { code: string }) => finding.code === 'MOTION_FINAL_HOLD'));
  const pkg = (result.toolCalls.at(-1)!.result as { package: any }).package;
  assert.equal(pkg.scenes[3].transitionOut.type, 'fade');
  assert.equal(pkg.scenes[3].transitionOut.direction, undefined);
  assert.equal(pkg.scenes[0].motion.entry, 'fadeUp');
  assert.equal(pkg.scenes.at(-1).preferredFrames > 15, true);
  const findings = lintMotion(pkg).filter((finding: { severity: string }) => finding.severity === 'error' || finding.severity === 'warning');
  assert.deepEqual(findings, [], JSON.stringify(lintMotion(pkg), null, 2));
  const validation = validatePackage(pkg);
  assert.equal(validation.valid, true, JSON.stringify(validation.errors, null, 2));
});

const FAKED_RUBRIC = JSON.stringify({
  scenes: [
    { id: 's_hook', readability: 9, rhythm: 10, continuity: 9, brand: 9, note: 'clear' },
    { id: 's_chart', readability: 6, rhythm: 5, continuity: 7, brand: 8, note: 'the number collides with the bars' },
    { id: 's_point', readability: 8, rhythm: 8, continuity: 8, brand: 8 },
  ],
});

test('critique stays off for a text-only provider and parses a faked rubric', async () => {
  assert.equal(providerDeclaresImageInput({ id: 'deepseek-v4.1' } as ChatModel), false);
  assert.equal(providerDeclaresImageInput({ imageInput: false }), false);
  assert.equal(providerDeclaresImageInput({ imageInput: true }), true);
  assert.equal(providerDeclaresImageInput({ capabilities: { imageInput: true } }), true);

  let calls = 0;
  const textOnly: ChatModel = {
    id: 'deepseek-v4.1',
    stream() {
      calls += 1;
      throw new Error('text-only provider was asked to judge a contact sheet');
    },
  };
  const skipped = await runMotionCritique({
    provider: textOnly,
    scenes: [{ id: 's_hook', headline: 'Plants store sunlight' }],
    sheetPath: 'out/sheet.png',
  });
  assert.deepEqual(skipped, { enabled: false, reason: 'provider does not declare image input' });
  assert.equal(calls, 0);

  const parsed = parseCritiqueReply(FAKED_RUBRIC, 1);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.fixSceneIds, ['s_chart']);
  assert.deepEqual(parsed.leaveSceneIds, ['s_hook']);
  assert.equal(parsed.scenes.find(scene => scene.id === 's_point')?.action, 'hold');
  assert.equal(parsed.stop, false);
  const lastRound = parseCritiqueReply(FAKED_RUBRIC, 2);
  assert.equal(lastRound.stop, true);
  assert.deepEqual(lastRound.fixSceneIds, ['s_chart']);

  const judge = new RecordingModel(() => [{ type: 'text', delta: FAKED_RUBRIC }], 'vision', true);
  const judged = await runMotionCritique({
    provider: judge,
    scenes: [
      { id: 's_hook', headline: 'Plants store sunlight' },
      { id: 's_chart', headline: 'Example data' },
      { id: 's_point', headline: 'Leaves make sugar' },
    ],
    sheetPath: 'out/sheet.png',
    round: 1,
  });
  assert.equal(judged.enabled, true);
  if (!judged.enabled) return;
  assert.equal(judged.request.tools.length, 0);
  assert.match(judged.request.system, /critique judge/);
  assert.doesNotMatch(judged.request.system, /storyboard\.propose/);
  assert.notEqual(judged.request.system, motionSystemSection());
  assert.deepEqual(judged.request.messages[0], {
    role: 'user',
    content: 'Score the MS4 contact sheet at out/sheet.png. Scenes: s_hook, s_chart, s_point.',
    images: [{ path: 'out/sheet.png', mediaType: 'image/png' }],
  });
  assert.deepEqual(judged.rubric.fixSceneIds, ['s_chart']);
  assert.deepEqual(judged.rubric.leaveSceneIds, ['s_hook']);
  assert.match(critiqueRubricPrompt({ scenes: [{ id: 's_hook' }], round: 2 }), /last round/i);

  let lateCalls = 0;
  const late: ChatModel & { imageInput: true } = {
    id: 'vision',
    imageInput: true,
    stream() {
      lateCalls += 1;
      throw new Error('a third critique round was started');
    },
  };
  const stopped = await runMotionCritique({ provider: late, scenes: [{ id: 's_hook' }], round: 3 });
  assert.equal(stopped.enabled, true);
  if (stopped.enabled) assert.equal(stopped.rubric.stop, true);
  assert.equal(lateCalls, 0);
});
