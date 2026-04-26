/**
 * Content script for chat.openai.com / chatgpt.com.
 *
 * ChatGPT's prompt input has changed several times. We try selectors in order:
 *   1. textarea#prompt-textarea (legacy)
 *   2. div#prompt-textarea[contenteditable="true"] (current ProseMirror)
 *   3. textarea[data-id="root"] (some experiments)
 */

import { watchForTextarea } from './overlay';
import { bridgePing, bridgeSearch, setEditorValue } from './inject-shared';
import { bootSmartInject } from './boot-smart';

function findTextarea(): HTMLElement | null {
  const candidates: (HTMLElement | null)[] = [
    document.querySelector('div#prompt-textarea[contenteditable="true"]'),
    document.querySelector('textarea#prompt-textarea'),
    document.querySelector('textarea[data-id="root"]'),
    document.querySelector('div[contenteditable="true"][data-virtualkeyboard="true"]'),
    document.querySelector('main form textarea'),
  ];
  for (const c of candidates) if (c) return c as HTMLElement;
  return null;
}

function readTextarea(): string {
  const el = findTextarea();
  if (!el) return '';
  if (el.isContentEditable) return el.innerText ?? '';
  if (el instanceof HTMLTextAreaElement) return el.value;
  return '';
}

function inject(text: string) {
  const el = findTextarea();
  if (el) setEditorValue(el, text);
}

watchForTextarea(findTextarea, {
  search: (q) => bridgeSearch(q),
  ping: () => bridgePing(),
  inject,
  readTextarea,
});

// Smart inject (opt-in via popup). Default off.
bootSmartInject(findTextarea, inject, readTextarea);
