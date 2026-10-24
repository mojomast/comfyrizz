# Interface: Easy home, Easy and Advanced modes, density and brand

## Easy home and steps

A bare visit opens **Easy home** (`apps/web/src/easy/home.ts`): **New video**, your recent videos
and **Try the example**, which opens Pip's Night Shift at its Review step. **New video** walks seven
steps (`apps/web/src/easy/router.ts`): **Idea**, **Characters**, **Iteration level**, **Plan**,
**Generate**, **Review** and **Export**. A step that is not ready yet says why (for example "Approve
the plan first"). The Iteration level step must be answered before a paid plan can be approved; see
[ITERATION_LEVELS.md](../ITERATION_LEVELS.md).

![Easy home](../media/ui-easy-home.webp)

## Easy and Advanced

The editor has two views (`apps/web/src/ui/mode.ts`, `prefs.ts`):

- **Easy** (default): the chat, preview and essentials; advanced controls are hidden.
- **Advanced** (the studio): chat, Remotion preview, inspector tabs (Scene, Voice, Animation,
  Agent, Takes, Generate, Production), the Activity / Files / Jobs rail and the timeline.

Toggle with **Open in editor** / **Back to studio** in the top bar or with **Ctrl/Cmd+Shift+A** (ignored while typing). The choice is saved
in the browser and announced to screen readers.

## Density

`comfortable` (default) or `compact`, saved with the mode. An explicit density choice is kept when
you switch modes.

## Kinetic ZZ brand

The Comfyrizz identity is called **Kinetic ZZ**. Vector masters (logo, wordmark, symbol, favicon,
social card) and tokens are in [`brand/`](../../brand/README.md); `brand/proof-sheet.html` shows
them together.
