interface ParkedPlayer {
  player: HTMLElement;
  parent: Node;
  next: ChildNode | null;
}

let parked: ParkedPlayer | null = null;

/** Remember the player's original home without moving it yet. */
export function holdPlayer(player: HTMLElement | null | undefined): void {
  if (!player || parked || !player.parentNode) return;
  parked = { player, parent: player.parentNode, next: player.nextSibling };
}

/** The player this page borrowed from the editor, even while it is detached. */
export function currentPlayer(): HTMLElement | null {
  return parked?.player ?? null;
}

/** Move the existing player node into the Easy slot. The same element keeps its React root. */
export function adoptPlayer(slot: HTMLElement, player: HTMLElement): void {
  if (!slot || !player || player.parentElement === slot) return;
  holdPlayer(player);
  slot.append(player);
}

/** Put the player back where it was before Easy borrowed it. */
export function releasePlayer(): void {
  if (!parked) return;
  const { player, parent, next } = parked;
  if (next && next.parentNode === parent) parent.insertBefore(player, next);
  else parent.appendChild(player);
  parked = null;
}
