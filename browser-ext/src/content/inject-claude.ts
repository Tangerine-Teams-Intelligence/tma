/**
 * Content script for claude.ai.
 *
 * Claude uses a ProseMirror contenteditable. The reliable selector as of
 * 2026-04 is `div[contenteditable="true"].ProseMirror` inside the chat
 * composer. We also try a couple of fallbacks.
 */

import { watchForTextarea } from './overlay';
import { bridgePing, bridgeSearch, setEditorValue } from './inject-shared';

function findTextarea(): HTMLElement | null {
  const candidates: (HTMLElement | null)[] = [
    document.querySelector('div[contenteditable="true"].ProseMirror'),
    document.querySelector('fieldset div[contenteditable="true"]'),
    document.querySelector('div[aria-label*="Send a message" i]'),
    document.querySelector('div[contenteditable="true"]'),
  ];
  for (const c of candidates) if (c) return c as HTMLElement;
  return null;
}

function readTextarea(): string {
  const el = findTextarea();
  if (!el) return '';
  return el.innerText ?? '';
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
