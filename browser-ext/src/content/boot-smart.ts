/**
 * boot-smart.ts — load smart-inject setting from chrome.storage.sync and
 * (en/dis)able the watcher accordingly. Listens for storage changes so
 * toggling in the popup takes effect without reload.
 */

import { DEFAULT_SETTINGS, type ExtensionSettings } from '../shared/types';
import { setSmartInjectEnabled, type SmartChipDeps } from './smart-chip';
import { bridgeSearchEnvelope } from './inject-shared';

export function bootSmartInject(
  findTextarea: () => HTMLElement | null,
  inject: (text: string) => void,
  readTextarea: () => string,
): void {
  const deps: SmartChipDeps = {
    search: (q) => bridgeSearchEnvelope(q, 5),
    inject,
    readTextarea,
    findTextarea,
  };

  // Storage may not exist in test environments (jsdom without chrome).
  // Guard the whole boot so failure is silent.
  try {
    chrome.storage.sync.get(null, (items) => {
      const merged: ExtensionSettings = {
        ...DEFAULT_SETTINGS,
        ...(items as Partial<ExtensionSettings>),
      };
      setSmartInjectEnabled(merged.smartInject === true, deps);
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      if ('smartInject' in changes) {
        const next = changes.smartInject.newValue === true;
        setSmartInjectEnabled(next, deps);
      }
    });
  } catch {
    /* swallow — chrome unavailable in some tests */
  }
}
