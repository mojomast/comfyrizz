import { buttonClassName, escapeHtml, type ButtonKind } from './components.ts';

export interface DialogAction {
  label: string;
  value: string;
  kind: ButtonKind;
}

export interface OpenDialogOptions {
  title: string;
  bodyHtml: string;
  actions: DialogAction[];
  opener?: HTMLElement | null;
}

export interface ConfirmDialogOptions {
  title: string;
  text: string;
  confirmLabel: string;
  cancelLabel: string;
  opener?: HTMLElement | null;
}

let dialogCounter = 0;

export function openDialog({ title, bodyHtml, actions, opener }: OpenDialogOptions): Promise<string | null> {
  const document = opener?.ownerDocument ?? globalThis.document;
  const dialogId = `easy-dialog-${++dialogCounter}`;
  const titleId = `${dialogId}-title`;

  const dialog = document.createElement('dialog');
  dialog.className = 'easy-dialog';
  dialog.id = dialogId;
  dialog.setAttribute('aria-labelledby', titleId);

  const titleElement = document.createElement('h2');
  titleElement.className = 'easy-dialog-title';
  titleElement.id = titleId;
  titleElement.textContent = title;

  const bodyElement = document.createElement('div');
  bodyElement.className = 'easy-dialog-body';
  bodyElement.innerHTML = bodyHtml;

  const actionsElement = document.createElement('div');
  actionsElement.className = 'easy-dialog-actions';

  const buttons = actions.map((action) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = buttonClassName(action.kind);
    button.value = action.value;
    button.textContent = action.label;
    actionsElement.append(button);
    return button;
  });

  dialog.append(titleElement, bodyElement, actionsElement);
  document.body.append(dialog);

  return new Promise((resolve) => {
    let settled = false;
    let result: string | null = null;

    const cleanup = () => {
      dialog.removeEventListener('cancel', onCancel);
      dialog.removeEventListener('close', onClose);
    };

    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (dialog.open) dialog.close();
      dialog.remove();
      if (opener && typeof opener.focus === 'function') opener.focus();
      resolve(value);
    };

    function onCancel(event: Event) {
      event.preventDefault();
      finish(null);
    }

    function onClose() {
      finish(result);
    }

    buttons.forEach((button, index) => {
      button.addEventListener('click', () => {
        result = actions[index].value;
        finish(result);
      });
    });

    dialog.addEventListener('cancel', onCancel);
    dialog.addEventListener('close', onClose);
    dialog.showModal();
  });
}

export function confirmDialog({
  title,
  text,
  confirmLabel,
  cancelLabel,
  opener,
}: ConfirmDialogOptions): Promise<boolean> {
  return openDialog({
    title,
    bodyHtml: `<p>${escapeHtml(text)}</p>`,
    actions: [
      { label: cancelLabel, value: 'cancel', kind: 'secondary' },
      { label: confirmLabel, value: 'confirm', kind: 'primary' },
    ],
    opener,
  }).then((value) => value === 'confirm');
}
