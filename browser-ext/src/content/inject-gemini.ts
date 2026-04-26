/**
 * Content script for gemini.google.com.
 *
 * Gemini uses a `<rich-textarea>` web component wrapping a contenteditable.
 * The composer container is `div.ql-editor` (Quill) inside `<rich-textarea>`.
 */

import { watchForTextarea } from './overlay';
import { bridgePing, bridgeSearch, setEditorValue } from './inject-shared';

function findTextarea(): HTMLElement | null {
  const candidates: (HTMLElement | null)[] = [
    document.querySelector('rich-textarea div.ql-editor[contenteditable="true"]'),
    document.querySelector('div.ql-editor[contenteditable="true"]'),
    document.querySelector('div[aria-label*="Enter a prompt" i]'),
    document.querySelector('rich-textarea div[contenteditable="true"]'),
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
