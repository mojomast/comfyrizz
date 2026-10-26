import { COPY, fill } from '../../easy/copy.ts';
import { renderCompute } from '../../easy/compute-choice.ts';
import { approveAndGenerate } from '../../easy/approve-generate.ts';
import type { EasyState } from '../../easy/types.ts';
import { planImpactSummary, readPlanCard } from '../../productions/cards/plan-card.ts';

export interface GenerateModel {
  compute: 'cpu' | 'colab';
  spendCap: number;
  spent?: number;
  snapshot?: unknown;
  colabStatus?: { signedIn?: boolean | null };
  renderCompute?: (input: {
    compute: 'cpu' | 'colab';
    colabStatus: { signedIn?: boolean | null };
    spendCap: number;
    spent: number;
    idPrefix?: string;
  }) => string;
}

type GenerateDeps = Parameters<typeof approveAndGenerate>[1];

/** Tab button inserted into the existing inspector tab list. */
export function generateTabButton(): string {
  return '<button type="button" role="tab" class="tab" id="sa-tab-generate" aria-controls="sa-section-generate" aria-selected="false" tabindex="-1" data-inspector-tab="generate">Generate</button>';
}

function computeMarkup(model: GenerateModel): string {
  const draw = model.renderCompute ?? renderCompute;
  return draw({
    compute: model.compute,
    colabStatus: model.colabStatus ?? { signedIn: null },
    spendCap: model.spendCap,
    spent: model.spent ?? 0,
    idPrefix: 'easy-inspector',
  });
}

function costMarkup(model: GenerateModel): string {
  if (model.compute !== 'colab') return `<p data-generate-cost>${COPY.plan.free}</p>`;
  const card = readPlanCard(model.snapshot);
  if (card.planId === null || card.reservationCeiling === null) return '<p data-generate-cost></p>';
  return `<div data-generate-cost><p>${fill(COPY.plan.cost, { n: card.reservationCeiling, cap: model.spendCap })}</p><p>${planImpactSummary(card)}</p></div>`;
}

/** Generate tab body: where to make it, the iteration slot, the cost, and the primary. */
export function renderGenerateTab(model: GenerateModel): string {
  const label = model.compute === 'colab' ? COPY.plan.approve : COPY.plan.generate;
  return `<section data-generate-tab>${computeMarkup(model)}<div data-il-slot="iteration-level-picker"></div>${costMarkup(model)}<button type="button" class="btn btn-primary" data-approve-generate>${label}</button></section>`;
}

/** The Generate primary. Paid work goes through approveAndGenerate. */
export function onGeneratePrimary(state: EasyState, deps: GenerateDeps): Promise<string | undefined> {
  return approveAndGenerate(state, deps);
}

export function mountInspectorGenerate(
  root: HTMLElement,
  options: { model: () => GenerateModel; onApprove: () => void },
): void {
  const tablist = root.querySelector<HTMLElement>('[data-testid="inspector-tabs"]');
  if (!tablist || tablist.querySelector('[data-inspector-tab="generate"]')) return;
  const holder = document.createElement('div');
  holder.innerHTML = generateTabButton();
  const button = holder.firstElementChild as HTMLButtonElement | null;
  if (!button) return;
  tablist.append(button);
  const panel = document.createElement('div');
  panel.id = 'sa-section-generate';
  panel.className = 'tab-panel';
  panel.setAttribute('role', 'tabpanel');
  panel.setAttribute('aria-labelledby', 'sa-tab-generate');
  panel.setAttribute('data-inspector-panel', 'generate');
  panel.hidden = true;
  root.append(panel);

  const paint = () => {
    panel.innerHTML = renderGenerateTab(options.model());
    panel.querySelector<HTMLButtonElement>('[data-approve-generate]')?.addEventListener('click', () => {
      options.onApprove();
    });
  };
  button.addEventListener('click', () => {
    tablist.querySelectorAll<HTMLButtonElement>('[role="tab"]').forEach((tab) => {
      const selected = tab === button;
      tab.setAttribute('aria-selected', selected ? 'true' : 'false');
      tab.tabIndex = selected ? 0 : -1;
    });
    root.querySelectorAll<HTMLElement>('[data-inspector-panel]').forEach((section) => {
      section.hidden = section !== panel;
    });
    paint();
  });
  paint();
}
