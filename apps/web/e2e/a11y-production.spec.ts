// @ts-nocheck
/**
 * IP64: Axe sweep of the production review, approval, conflict and modal
 * surfaces. The cards and dialogs are rendered from the same pure modules the
 * app mounts, using durable-record-shaped data. No server, Google Colab
 * session, paid backend or network call is involved.
 *
 * Every serious or critical violation fails the sweep with no exceptions.
 * Moderate and minor findings stay visible in the report without failing.
 */
import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { existsSync } from 'node:fs';

function systemChromium(): string | undefined {
  return ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']
    .find(candidate => existsSync(candidate));
}

const chromiumPath = systemChromium();
if (chromiumPath) test.use({ launchOptions: { executablePath: chromiumPath } });

test.setTimeout(60_000);

const PRODUCTION_ID = 'prod_0123456789abcdef01234567';
const PLAN_HASH = 'c'.repeat(64);

type AxeFinding = {
  id: string;
  impact: string | null;
  nodes: Array<string | string[]>;
};

function describeFinding(item: { id: string; impact?: string | null; nodes: Array<{ target: string[] }> }): AxeFinding {
  return {
    id: item.id,
    impact: item.impact ?? null,
    nodes: item.nodes.slice(0, 3).map(node => node.target),
  };
}

function seriousFindings(violations: readonly { id: string; impact?: string | null; nodes: Array<{ target: string[] }> }[]): AxeFinding[] {
  return violations
    .filter(item => item.impact === 'serious' || item.impact === 'critical')
    .map(describeFinding);
}

async function openHarness(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/ui-kit.html');
  await page.evaluate(async () => {
    await import('/src/style.css');
    await import('/src/takes/panel.css');
    await import('/src/project-chat.css');
    await import('/src/characters/characters.css');
    await import('/src/ui/palette.css');
  });
}

async function installMarkup(page: import('@playwright/test').Page, markup: string): Promise<void> {
  await page.evaluate(body => {
    document.body.innerHTML = `<main id="a11y-harness"><h1>Production accessibility states</h1>${body}</main>`;
  }, markup);
}

async function expectNoSeriousOrCritical(page: import('@playwright/test').Page, state: string): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  const serious = seriousFindings(results.violations);
  expect(serious, `${state}: serious or critical Axe findings`).toEqual([]);
}

test('review drawer states have no serious accessibility violations', async ({ page }) => {
  await openHarness(page);
  for (const [filter, expectedRows] of [['needs', 1], ['stale', 1], ['failed', 1], ['approved', 1]] as const) {
    const markup = await page.evaluate(async ({ productionId, planHash, filter }) => {
      const mod = await import('/src/takes/review-drawer.ts');
      const clip = (n: number, overrides: Record<string, unknown>) => ({
        clipId: `s${n}:a_plate${n}`,
        sceneId: `s${n}`,
        assetId: n <= 2 ? 'a_plate_shared' : `a_plate${n}`,
        slot: n % 2 === 0 ? 'background' : 'presenter',
        kind: n % 2 === 0 ? 'plate' : 'presenter',
        from: (n - 1) * 90,
        durationInFrames: 90,
        state: 'review',
        selected: `tk_${String(n).repeat(12)}`,
        selectedN: 2,
        takeCount: 4,
        newTakes: 1,
        lastJob: null,
        queued: false,
        ...overrides,
      });
      const clips = [
        clip(1, { state: 'review' }),
        clip(2, { state: 'stale' }),
        clip(3, { state: 'failed' }),
        clip(4, { state: 'approved' }),
      ];
      const costCard = {
        productionId,
        planId: 'plan_ip64_review',
        planHash,
        proposalRevision: 1,
        revision: 4,
        clipId: 's1:a_plate1',
        assetId: 'a_plate_shared',
        reservationCeiling: 12,
        backendId: 'google colab',
        requiredDecisions: [],
        actions: [
          { id: 'act_ip64_1', kind: 'shot.generate', targetId: 'shot_1', upperBound: 5, reuse: false },
          { id: 'act_ip64_2', kind: 'shot.reuse', targetId: 'shot_2', upperBound: 2, reuse: true },
        ],
        commandId: 'cmd_ip64_review',
      };
      return mod.renderReviewDrawer(clips, {
        id: 'a11y-review-drawer',
        open: true,
        filter,
        sort: 'status',
        costCard,
        packageId: 'pkg_ip64',
        takesApi: null,
      });
    }, { productionId: PRODUCTION_ID, planHash: PLAN_HASH, filter });
    await installMarkup(page, `<section aria-label="Production review (${filter})"><div id="review-host">${markup}</div></section>`);
    await page.evaluate(() => {
      const form = document.querySelector<HTMLFormElement>('[data-render-override]')!;
      form.hidden = false;
      const reason = form.querySelector<HTMLTextAreaElement>('[data-override-reason]')!;
      reason.value = 'Producer approved the preview so the export can continue.';
      const costError = document.querySelector<HTMLElement>('[data-review-cost-error]');
      if (costError) costError.textContent = 'The plan changed after this card was opened. Propose it again.';
    });

    await expect(page.locator('[data-review-drawer]')).toBeVisible();
    await expect(page.locator('[data-review-cost-card]')).toBeVisible();
    await expect(page.locator('[data-render-override]')).toBeVisible();
    await expect(page.locator('[data-review-clip]')).toHaveCount(expectedRows);
    await expect(page.locator(`[data-review-clip][data-review-status="${filter}"]`)).toHaveCount(expectedRows);
    await expectNoSeriousOrCritical(page, `review drawer filter ${filter}`);
  }
});

test('approval card states have no serious accessibility violations', async ({ page }) => {
  await openHarness(page);
  const markup = await page.evaluate(async ({ productionId, planHash }) => {
    const planMod = await import('/src/productions/cards/plan-card.ts');
    const scriptMod = await import('/src/productions/cards/script-card.ts');

    const planEvent = {
      id: 'evt_ip64_plan',
      sequence: 3,
      productionId,
      type: 'plan.proposed',
      data: {
        id: 'plan_ip64',
        productionId,
        revision: 0,
        planHash,
        reservationCeiling: 9,
        collectAndStopReserve: 2,
        requiredDecisions: ['music'],
        actions: [
          { id: 'act_1', kind: 'shot.generate', targetId: 'shot_1', upperBound: 3, reuse: false },
          { id: 'act_2', kind: 'shot.reuse', targetId: 'shot_2', upperBound: 2, reuse: true },
          { id: 'act_3', kind: 'shot.generate', targetId: 'shot_3', upperBound: 2 },
        ],
      },
    };
    const decision = (type: string) => ({
      id: `evt_${type}`,
      sequence: 4,
      productionId,
      type,
      data: { planId: 'plan_ip64', planHash, proposalRevision: 0 },
    });
    const state = (overrides: Record<string, unknown> = {}) => ({
      production: { id: productionId, revision: 4 },
      revision: 4,
      lastSequence: 4,
      events: [planEvent],
      ...overrides,
    });
    const plan = (overrides = {}) => planMod.renderPlanCard(planMod.readPlanCard(state(overrides)));
    const cards = [
      plan(),
      plan({ events: [planEvent, decision('plan.approved')] }),
      plan({ events: [planEvent, decision('plan.rejected')] }),
      plan({ stale: true }),
      planMod.renderPlanCard(planMod.loadingPlanCard(productionId)),
      planMod.renderPlanCard(planMod.errorPlanCard('The plan record could not be read.', productionId)),
    ];

    const script = scriptMod.readScriptCard({
      production: {
        schema: 'comfyrizz.production/v1',
        id: productionId,
        revision: 2,
        treatment: 'A night-shift automation agent learns the shape of the city.',
        script: 'NARRATOR: Every night, the work begins again.',
        shots: [
          {
            id: 'shot_1',
            title: 'Open on the night city',
            description: 'A slow push through wet streets.',
            dialogue: 'Every night, the work begins.',
            approved: true,
            approvedRevision: 3,
          },
          {
            id: 'shot_2',
            title: 'The agent wakes',
            description: 'A calm interface unfolds across the desk.',
            dialogue: 'It already knows the plan.',
          },
        ],
      },
      revision: 2,
    }, { idPrefix: 'a11y-script' });
    cards.push(scriptMod.renderScriptCard(script, { idPrefix: 'a11y-script' }));
    return cards.join('');
  }, { productionId: PRODUCTION_ID, planHash: PLAN_HASH });
  await installMarkup(page, `<section aria-label="Production approvals">${markup}</section>`);

  await expect(page.locator('[data-plan-card]')).toHaveCount(6);
  await expect(page.locator('[data-plan-approval="approved"]')).toHaveCount(1);
  await expect(page.locator('[data-plan-approval="rejected"]')).toHaveCount(1);
  await expect(page.locator('[data-plan-card][data-card-stale="true"]')).toHaveCount(1);
  await expect(page.locator('[data-shot-lock-label]')).toHaveCount(1);
  await expectNoSeriousOrCritical(page, 'plan approval and locked shot states');
});

test('conflict and recovery states have no serious accessibility violations', async ({ page }) => {
  await openHarness(page);
  const markup = await page.evaluate(async ({ productionId, planHash }) => {
    const recovery = await import('/src/chat-recovery.ts');
    const planMod = await import('/src/productions/cards/plan-card.ts');
    const scriptMod = await import('/src/productions/cards/script-card.ts');
    const progressMod = await import('/src/productions/cards/progress.ts');

    const recoveryPanel = recovery.recoveryPanelHtml({
      conversationId: 'conv_ip64',
      turnId: 'turn_ip64',
      found: 7,
      expected: 6,
    });

    const planEvent = {
      id: 'evt_ip64_conflict_plan',
      sequence: 3,
      productionId,
      type: 'plan.proposed',
      data: {
        id: 'plan_ip64_conflict',
        productionId,
        revision: 0,
        planHash,
        reservationCeiling: 7,
        collectAndStopReserve: 1,
        requiredDecisions: [],
        actions: [{ id: 'act_1', kind: 'shot.generate', targetId: 'shot_1', upperBound: 7, reuse: false }],
      },
    };
    const stalePlan = planMod.renderPlanCard(planMod.readPlanCard({
      production: { id: productionId, revision: 8 },
      revision: 8,
      lastSequence: 6,
      gap: true,
      events: [planEvent],
    }));

    const staleScript = scriptMod.renderScriptCard(scriptMod.readScriptCard({
      production: {
        schema: 'comfyrizz.production/v1',
        id: productionId,
        revision: 8,
        treatment: 'The last durable treatment.',
        script: 'NARRATOR: The last durable script.',
        shots: [{ id: 'shot_1', title: 'Last durable shot', description: 'Held while the client catches up.' }],
      },
      revision: 8,
      gap: true,
    }, { idPrefix: 'a11y-conflict-script' }), { idPrefix: 'a11y-conflict-script' });

    const staleProgress = progressMod.renderProgressCard({
      shots: [
        { shotId: 'shot_1', label: 'Open on the night city', status: 'approved' },
        { shotId: 'shot_2', label: 'The agent wakes', status: 'stale' },
      ],
    }, { state: 'stale' });

    return `${recoveryPanel}${stalePlan}${staleScript}${staleProgress}`;
  }, { productionId: PRODUCTION_ID, planHash: PLAN_HASH });
  await installMarkup(page, `<section aria-label="Production conflict states">${markup}</section>`);

  await expect(page.locator('[data-recovery-turn-id="turn_ip64"]')).toBeVisible();
  await expect(page.locator('[data-plan-card][data-card-stale="true"]')).toHaveCount(1);
  await expect(page.locator('[data-script-card][data-card-stale="true"]')).toHaveCount(1);
  await expect(page.locator('[data-production-card="progress"][data-card-state="stale"]')).toHaveCount(1);
  await expectNoSeriousOrCritical(page, 'recovery conflict and stale durable records');
});

test('modal states have no serious accessibility violations', async ({ page }) => {
  await openHarness(page);
  const markup = await page.evaluate(async () => {
    const cast = await import('/src/characters/cast-strip.ts');
    const palette = await import('/src/ui/palette.ts');

    const before = {
      schema: 'comfyrizz.character/v1',
      id: 'chr_ip64',
      revision: 2,
      name: 'Pip',
      handle: 'pip',
      role: 'mascot',
      kind: 'fictional',
      summary: 'Round, cheerful coffee-bean mascot',
      visual: {
        identityPrompt: 'small round coffee bean, glossy brown',
        negative: 'no human face',
        style: 'flat 3D',
        palette: ['#5b3a1e'],
        wardrobe: [{ id: 'w1', label: 'barista apron', prompt: 'green apron', default: true }],
        expressions: [],
        images: [],
        sheet: { status: 'none' },
        seed: null,
        identity: { method: 'klein_ref' },
      },
      voice: { engine: 'kokoro', voice: 'am_michael', sampleLines: ['Morning!'] },
      bible: {
        personality: 'upbeat',
        mannerisms: [],
        catchphrases: [],
        speakingStyle: 'short sentences',
        do: [],
        dont: [],
        notes: '',
      },
      tags: ['coffee'],
      createdAt: '2026-10-20T00:00:00.000Z',
      updatedAt: '2026-10-20T00:00:00.000Z',
    };
    const after = {
      ...before,
      revision: 3,
      summary: 'Round, cheerful coffee-bean mascot with a new apron',
      visual: {
        ...before.visual,
        wardrobe: [{ id: 'w1', label: 'barista apron', prompt: 'indigo apron', default: true }],
      },
    };
    const castModal = cast.renderCastDiff({
      chatId: 'conv_ip64',
      cast: [{
        castId: 'cast_ip64',
        characterId: before.id,
        pinnedRevision: before.revision,
        snapshot: before,
        overrides: {},
        detached: false,
        orphaned: false,
      }],
      library: [after],
      loading: false,
      busy: false,
      message: '',
      messageError: false,
      diffCastId: 'cast_ip64',
    });

    const commands = [
      { id: 'open-settings', title: 'Open agent settings', description: 'Connect a model provider', shortcut: 'Ctrl+,' },
      { id: 'open-review', title: 'Open review takes', description: 'Review landed clips', shortcut: 'R' },
      { id: 'open-export', title: 'Export video', description: 'Render the approved cut' },
    ];
    const commandPalette = palette.renderPalette(commands);
    const shortcutSheet = palette.renderShortcutSheet(commands);
    return `${castModal}${commandPalette}${shortcutSheet}`;
  });
  await installMarkup(page, `<section aria-label="Production modal states">${markup}</section>`);

  await expect(page.locator('[data-cast-diff-modal]')).toBeVisible();
  await expect(page.locator('[data-palette="true"]')).toBeVisible();
  await expect(page.locator('[data-shortcut-sheet="true"]')).toBeVisible();
  await expectNoSeriousOrCritical(page, 'revision diff, command palette and shortcut sheet');
});
