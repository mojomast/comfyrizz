interface ParkedPlayer {
  player: HTMLElement;
  parent: Node;
  next: ChildNode | null;
}

let parked: ParkedPlayer | null = null;

/** Move the existing player node into the Easy slot. The same element keeps its React root. */
export function adoptPlayer(slot: HTMLElement, player: HTMLElement): void {
  if (!slot || !player || player.parentElement === slot) return;
  if (!parked && player.parentNode) {
    parked = { player, parent: player.parentNode, next: player.nextSibling };
  }
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
