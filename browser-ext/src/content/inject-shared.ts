/**
 * Shared bridge between content scripts and the background service worker.
 *
 * Content scripts cannot open ws:// to localhost from a https origin without
 * mixed-content errors. We proxy memory calls through the background service
 * worker which has more relaxed network rules.
 */

import type {
  BridgeMessage,
  BridgeResponse,
  MemoryResult,
} from '../shared/types';

export async function bridgeSearch(query: string, limit = 5): Promise<MemoryResult[]> {
  const resp = await sendMessage<MemoryResult[]>({
    type: 'memory.search',
    payload: { query, limit },
  });
  if (!resp.ok) return [];
  return resp.data ?? [];
}

export async function bridgePing(): Promise<boolean> {
  const resp = await sendMessage<{ reachable: boolean }>({ type: 'memory.status' });
  return Boolean(resp.ok && resp.data?.reachable);
}

function sendMessage<T>(msg: BridgeMessage): Promise<BridgeResponse<T>> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (response: BridgeResponse<T>) => {
        if (chrome.runtime.lastError || !response) {
          resolve({ ok: false, error: chrome.runtime.lastError?.message ?? 'no response' });
          return;
        }
        resolve(response);
      });
    } catch (err) {
      resolve({ ok: false, error: (err as Error).message });
    }
  });
}

/**
 * Set the value of a textarea or contenteditable, fire the right input event so
 * the host site's React/Vue/Angular state catches up. Falls back to direct
 * setter calls for textarea/input via React's `nativeInputValueSetter` trick.
 */
export function setEditorValue(el: HTMLElement, prependText: string) {
  if (!el) return;

  // contenteditable (Claude, ChatGPT new ProseMirror).
  if (el.isContentEditable || el.getAttribute('contenteditable') === 'true') {
    // Create a paragraph with the prepended content.
    const existing = el.innerText ?? '';
    const newText = prependText.trim() + (existing ? '\n\n' + existing : '');
    // Replace innerText. Most contenteditable editors observe input events.
    el.focus();
    // Try the safer path first: select all + insertText (browser handles undo).
    try {
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      if (sel) {
        sel.removeAllRanges();
        sel.addRange(range);
        document.execCommand('insertText', false, newText);
        return;
      }
    } catch {
      /* fall through */
    }
    el.innerText = newText;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: newText }));
    return;
  }

  // <textarea> / <input>.
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    const existing = el.value;
    const next = prependText.trim() + (existing ? '\n\n' + existing : '');
    if (setter) {
      setter.call(el, next);
    } else {
      el.value = next;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.focus();
    return;
  }

  // Unknown element — best effort.
  (el as any).value = prependText;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
