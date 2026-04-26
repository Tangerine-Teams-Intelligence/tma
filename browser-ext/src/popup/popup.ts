/**
 * Browser-action popup — settings UI.
 */

import { DEFAULT_SETTINGS, type ExtensionSettings } from '../shared/types';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const els = {
  endpoint: () => $<HTMLInputElement>('endpoint'),
  chatgpt: () => $<HTMLInputElement>('site-chatgpt'),
  claude: () => $<HTMLInputElement>('site-claude'),
  gemini: () => $<HTMLInputElement>('site-gemini'),
  limit: () => $<HTMLInputElement>('limit'),
  autoprefill: () => $<HTMLInputElement>('autoprefill'),
  status: () => $<HTMLDivElement>('status'),
  save: () => $<HTMLButtonElement>('btn-save'),
  test: () => $<HTMLButtonElement>('btn-test'),
};

async function load(): Promise<ExtensionSettings> {
  return new Promise((resolve) => {
    chrome.storage.sync.get(null, (items) => {
      const merged: ExtensionSettings = {
        ...DEFAULT_SETTINGS,
        ...(items as Partial<ExtensionSettings>),
        enabledSites: {
          ...DEFAULT_SETTINGS.enabledSites,
          ...(items?.enabledSites ?? {}),
        },
      };
      resolve(merged);
    });
  });
}

function paint(s: ExtensionSettings) {
  els.endpoint().value = s.endpoint;
  els.chatgpt().checked = s.enabledSites.chatgpt;
  els.claude().checked = s.enabledSites.claude;
  els.gemini().checked = s.enabledSites.gemini;
  els.limit().value = String(s.resultLimit);
  els.autoprefill().checked = s.autoPrefill;
}

function harvest(): ExtensionSettings {
  return {
    endpoint: els.endpoint().value.trim() || DEFAULT_SETTINGS.endpoint,
    enabledSites: {
      chatgpt: els.chatgpt().checked,
      claude: els.claude().checked,
      gemini: els.gemini().checked,
    },
    resultLimit: Math.max(1, Math.min(20, Number(els.limit().value) || 5)),
    autoPrefill: els.autoprefill().checked,
  };
}

async function save() {
  const s = harvest();
  await new Promise<void>((resolve) => chrome.storage.sync.set(s, () => resolve()));
  setStatus('Saved.', 'ok');
}

function setStatus(text: string, kind: 'ok' | 'bad' | '' = '') {
  const el = els.status();
  el.textContent = text;
  el.className = 'status' + (kind ? ' ' + kind : '');
}

async function test() {
  setStatus('Testing…');
  // Save first so the background uses the typed endpoint.
  await save();
  const resp = await new Promise<{ ok: boolean; data?: { reachable: boolean } }>((resolve) => {
    chrome.runtime.sendMessage({ type: 'memory.status' }, (r) => resolve(r ?? { ok: false }));
  });
  if (resp?.ok && resp.data?.reachable) {
    setStatus('Desktop app reachable.', 'ok');
  } else {
    setStatus('Desktop app not reachable.', 'bad');
  }
}

(async () => {
  paint(await load());
  els.save().addEventListener('click', save);
  els.test().addEventListener('click', test);
  // Initial reachability probe.
  test().catch(() => setStatus('Could not check.', 'bad'));
})();
