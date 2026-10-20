const HTML_ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => HTML_ESCAPES[char]);

const MESSAGE_ROLES = new Set(['user', 'assistant', 'system', 'tool']);

const roleOf = value => {
  const role = String(value ?? 'assistant').toLowerCase();
  return MESSAGE_ROLES.has(role) ? role : 'other';
};

const textOf = message => {
  if (!message || typeof message !== 'object') return '';
  if (typeof message.text === 'string') return message.text;
  if (typeof message.content === 'string') return message.content;
  if (typeof message.message === 'string') return message.message;
  return '';
};

const renderInline = value => {
  let out = '';
  let index = 0;

  while (index < value.length) {
    if (value[index] === '`') {
      const end = value.indexOf('`', index + 1);
      if (end > index + 1) {
        out += `<code>${value.slice(index + 1, end)}</code>`;
        index = end + 1;
        continue;
      }
    }

    if (value.startsWith('**', index)) {
      const end = value.indexOf('**', index + 2);
      if (end > index + 2) {
        out += `<strong>${renderInline(value.slice(index + 2, end))}</strong>`;
        index = end + 2;
        continue;
      }
    }

    out += value[index];
    index += 1;
  }

  return out;
};

const inlineEscaped = value => renderInline(escapeHtml(String(value ?? '').trim()));

const renderBlock = block => {
  const parts = [];
  let paragraph = [];
  let list = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    parts.push(`<p>${paragraph.join('<br>')}</p>`);
    paragraph = [];
  };

  const flushList = () => {
    if (list.length === 0) return;
    parts.push(`<ul>${list.map(item => `<li>${item}</li>`).join('')}</ul>`);
    list = [];
  };

  for (const line of block.split('\n')) {
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item) {
      flushParagraph();
      list.push(inlineEscaped(item[1]));
      continue;
    }

    flushList();
    const trimmed = line.trim();
    if (trimmed === '') {
      flushParagraph();
    } else {
      paragraph.push(inlineEscaped(trimmed));
    }
  }

  flushList();
  flushParagraph();
  return parts.join('');
};

export function renderMarkdown(value) {
  const source = String(value ?? '').replace(/\r\n?/g, '\n').trim();
  if (source === '') return '';
  return source.split(/\n{2,}/).map(renderBlock).join('');
}

const renderMessages = messages => {
  const list = Array.isArray(messages) ? messages : [];

  return list.map(message => {
    const role = roleOf(message?.role);
    const text = textOf(message);
    return `<li class="chat-message chat-message--${role}" data-role="${role}"><div class="chat-bubble">${renderMarkdown(text)}</div></li>`;
  }).join('');
};

const modelBadgeText = modelLabel => {
  const label = String(modelLabel ?? '').trim() || 'model';
  return `${label} - any OpenAI-compatible model works`;
};

export function renderChat(messages, options = {}) {
  const { modelLabel, pending = false } = options ?? {};
  const isPending = Boolean(pending);
  const disabled = isPending ? ' disabled' : '';

  return `<section class="chat-panel" data-pending="${isPending ? 'true' : 'false'}">
<header class="chat-head"><span class="chat-model-badge">${escapeHtml(modelBadgeText(modelLabel))}</span></header>
<ol class="chat-messages" aria-live="polite" aria-label="Conversation">${renderMessages(messages)}</ol>
${isPending ? '<div class="chat-pending" role="status" aria-live="polite"><span class="chat-pending-dot" aria-hidden="true"></span>Thinking\u2026</div>' : ''}
<form class="chat-composer">
<textarea class="chat-input" name="message" rows="2" placeholder="Describe the video you want\u2026" aria-label="Message"${disabled}></textarea>
<div class="chat-composer-actions"><span class="chat-hint">Enter to send \u00b7 Shift+Enter for a new line</span><button class="chat-send" type="submit"${disabled}>Send</button></div>
</form>
</section>`;
}

const classListOf = element => {
  const raw = element?.className;
  if (typeof raw === 'string') return raw.split(/\s+/).filter(Boolean);
  return [];
};

const hasClass = (element, name) => {
  if (!element) return false;
  const list = element.classList;
  if (list && typeof list.contains === 'function' && list.contains(name)) return true;
  return classListOf(element).includes(name);
};

const isChatInput = element => hasClass(element, 'chat-input');

const isSendControl = element => {
  if (!element) return false;
  if (typeof element.closest === 'function') {
    try {
      if (element.closest('.chat-send')) return true;
    } catch {
      return false;
    }
  }
  return hasClass(element, 'chat-send');
};

const asMessageList = value => (Array.isArray(value) ? value : []);

export function mountChat(root, options = {}) {
  if (!root || typeof root !== 'object') {
    throw new TypeError('mountChat requires a root element');
  }

  const settings = options ?? {};
  let messages = asMessageList(settings.messages);
  let modelLabel = settings.modelLabel;
  let pending = Boolean(settings.pending);
  let sendPending = false;
  let draft = '';
  let destroyed = false;

  const isPending = () => pending || sendPending;
  const findInput = () => root.querySelector?.('.chat-input') ?? null;

  const render = () => {
    if (destroyed) return;
    const previous = findInput();
    const wasFocused = previous?.ownerDocument?.activeElement === previous;
    if (previous && typeof previous.value === 'string') draft = previous.value;
    root.innerHTML = renderChat(messages, { modelLabel, pending: isPending() });
    const input = findInput();
    if (input) {
      input.value = draft;
      if (wasFocused) input.focus?.();
    }
  };

  const send = () => {
    if (destroyed || isPending()) return;
    const input = findInput();
    const text = String(input?.value ?? draft).trim();
    if (text === '') return;

    draft = '';
    if (input) input.value = '';

    let result;
    try {
      result = settings.onSend?.(text);
    } catch (error) {
      render();
      throw error;
    }

    if (result && typeof result.then === 'function') {
      sendPending = true;
      render();
      Promise.resolve(result).then(
        () => {
          sendPending = false;
          render();
        },
        () => {
          sendPending = false;
          render();
        },
      );
    }
  };

  const onSubmit = event => {
    event?.preventDefault?.();
    send();
  };

  const onClick = event => {
    if (!isSendControl(event?.target)) return;
    event?.preventDefault?.();
    send();
  };

  const onKeyDown = event => {
    if (!event || event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    const target = event.target;
    if (target && target !== root && !isChatInput(target)) return;
    if (!findInput()) return;
    event.preventDefault?.();
    send();
  };

  root.addEventListener?.('submit', onSubmit);
  root.addEventListener?.('click', onClick);
  root.addEventListener?.('keydown', onKeyDown);
  render();

  const update = next => {
    const patch = Array.isArray(next) ? { messages: next } : next ?? {};
    if ('messages' in patch) messages = asMessageList(patch.messages);
    if ('modelLabel' in patch) modelLabel = patch.modelLabel;
    if ('pending' in patch) pending = Boolean(patch.pending);
    render();
  };

  return {
    update,
    setMessages(next) {
      messages = asMessageList(next);
      render();
    },
    setModel(model) {
      modelLabel = model;
      render();
    },
    setPending(value) {
      pending = Boolean(value);
      render();
    },
    focus() {
      findInput()?.focus?.();
    },
    get pending() {
      return isPending();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      root.removeEventListener?.('submit', onSubmit);
      root.removeEventListener?.('click', onClick);
      root.removeEventListener?.('keydown', onKeyDown);
      root.innerHTML = '';
    },
  };
}
