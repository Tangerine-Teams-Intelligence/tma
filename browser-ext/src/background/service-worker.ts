/**
 * Background service worker.
 *
 * Responsibilities:
 *   - Bridge content scripts ↔ Tangerine desktop app (localhost ws).
 *   - Cache the latest reachability status to avoid spamming the app.
 *   - Hold settings in chrome.storage.sync.
 */

import { MemoryClient } from '../shared/memory-client';
import {
  DEFAULT_SETTINGS,
  type BridgeMessage,
  type BridgeResponse,
  type ExtensionSettings,
} from '../shared/types';

let cachedSettings: ExtensionSettings = DEFAULT_SETTINGS;
let client: MemoryClient | null = null;

async function loadSettings(): Promise<ExtensionSettings> {
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

function refreshClient() {
  client = new MemoryClient({ endpoint: cachedSettings.endpoint, timeoutMs: 4000 });
}

(async () => {
  cachedSettings = await loadSettings();
  refreshClient();
})();

chrome.storage.onChanged.addListener(async (_changes, area) => {
  if (area === 'sync') {
    cachedSettings = await loadSettings();
    refreshClient();
  }
});

chrome.runtime.onMessage.addListener(
  (msg: BridgeMessage, _sender, sendResponse) => {
    handleMessage(msg)
      .then((resp) => sendResponse(resp))
      .catch((err) =>
        sendResponse({ ok: false, error: (err as Error).message } satisfies BridgeResponse)
      );
    // Async response.
    return true;
  }
);

async function handleMessage(msg: BridgeMessage): Promise<BridgeResponse> {
  if (!client) refreshClient();
  const c = client!;
  switch (msg.type) {
    case 'memory.search': {
      const { query, limit } = (msg.payload ?? {}) as { query: string; limit?: number };
      const out = await c.search(query, limit ?? cachedSettings.resultLimit);
      if (out.ok) {
        // Forward the AGI envelope alongside results so the smart-chip UI
        // can render confidence (Hook 4 of STAGE1_AGI_HOOKS.md).
        return { ok: true, data: { results: out.results, envelope: out.envelope } };
      }
      return { ok: false, error: `${out.code}: ${out.message}` };
    }
    case 'memory.file': {
      const { path } = (msg.payload ?? {}) as { path: string };
      const out = await c.file(path);
      if (out.ok) return { ok: true, data: { path: out.path, content: out.content } };
      return { ok: false, error: `${out.code}: ${out.message}` };
    }
    case 'memory.status': {
      const out = await c.ping();
      return { ok: true, data: { reachable: out.ok } };
    }
    default:
      return { ok: false, error: 'unknown message type' };
  }
}

// Lifecycle: log install for debug.
chrome.runtime.onInstalled.addListener((details) => {
  console.log('[Tangerine] installed', details.reason);
});
