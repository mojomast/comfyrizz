# Interface: Easy and Advanced modes, density and brand

## Easy and Advanced

The editor has two views (`apps/web/src/ui/mode.ts`, `prefs.ts`):

- **Easy** (default): the chat, preview and essentials; advanced controls are hidden.
- **Advanced**: every control is visible.

Toggle from the top bar or with **Ctrl/Cmd+Shift+A** (ignored while typing). The choice is saved
in the browser and announced to screen readers.

## Density

`comfortable` (default) or `compact`, saved with the mode. An explicit density choice is kept when
you switch modes.

## Kinetic ZZ brand

The Comfyrizz identity is called **Kinetic ZZ**. Vector masters (logo, wordmark, symbol, favicon,
social card) and tokens are in [`brand/`](../../brand/README.md); `brand/proof-sheet.html` shows
them together.
