/**
 * Overlay — vanilla DOM search panel injected into ChatGPT/Claude/Gemini.
 *
 * No React. Content scripts share the page's main world only via DOM, and
 * shipping React per-tab is wasteful. All styles are inlined / scoped via a
 * unique class prefix `tng-` to avoid colliding with the host site.
 */

import type { MemoryResult } from '../shared/types';
import { extractQueryFromTextarea, formatResultForInjection } from '../shared/memory-client';

export interface OverlayDeps {
  /** Run search. Should return [] on error so the UI shows empty state. */
  search: (query: string) => Promise<MemoryResult[]>;
  /** Inject result text into the host site's prompt. */
  inject: (text: string) => void;
  /** Read current textarea contents to seed the query. */
  readTextarea: () => string;
  /** Returns true if the desktop app is reachable (controls banner). */
  ping: () => Promise<boolean>;
}

const STYLE_ID = 'tng-overlay-styles';
const BTN_ID = 'tng-trigger-btn';
const PANEL_ID = 'tng-overlay-panel';

const ORANGE = '#CC5500';
const NAVY = '#1A1A2E';

function injectStylesOnce() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    #${BTN_ID} {
      position: fixed;
      width: 28px;
      height: 28px;
      border-radius: 50%;
      background: ${ORANGE};
      color: white;
      font-size: 16px;
      line-height: 28px;
      text-align: center;
      cursor: pointer;
      z-index: 2147483646;
      opacity: 0.5;
      transition: opacity 100ms ease, transform 100ms ease;
      box-shadow: 0 2px 6px rgba(0,0,0,0.2);
      user-select: none;
      border: none;
      padding: 0;
      font-family: -apple-system, system-ui, sans-serif;
    }
    #${BTN_ID}:hover { opacity: 1; transform: scale(1.05); }
    #${BTN_ID}:active { transform: scale(0.95); }

    #${PANEL_ID} {
      position: fixed;
      width: 480px;
      max-width: calc(100vw - 32px);
      max-height: 320px;
      background: white;
      color: ${NAVY};
      border-radius: 8px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.25);
      z-index: 2147483647;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      font-family: -apple-system, system-ui, "Segoe UI", sans-serif;
      transform: translateY(20px);
      opacity: 0;
      transition: transform 150ms ease, opacity 150ms ease;
    }
    #${PANEL_ID}.tng-open { transform: translateY(0); opacity: 1; }

    @media (prefers-color-scheme: dark) {
      #${PANEL_ID} { background: #1f1f23; color: #ececec; }
      .tng-result { border-bottom-color: #2a2a30 !important; }
      .tng-result:hover { background: #28282e !important; }
      .tng-input { background: #15151a !important; color: #ececec !important; border-color: #2a2a30 !important; }
      .tng-banner { background: #2a1a0a !important; color: #ffb380 !important; }
    }

    .tng-header {
      padding: 12px 14px 8px;
      display: flex;
      align-items: center;
      gap: 8px;
      border-bottom: 1px solid rgba(0,0,0,0.06);
    }
    .tng-header-title { font-weight: 600; font-size: 13px; flex: 1; }
    .tng-header-close {
      background: transparent; border: none; cursor: pointer;
      font-size: 18px; line-height: 1; color: inherit; opacity: 0.6;
      padding: 2px 6px;
    }
    .tng-header-close:hover { opacity: 1; }

    .tng-input-wrap { padding: 10px 14px 8px; }
    .tng-input {
      width: 100%; box-sizing: border-box;
      padding: 8px 10px;
      border: 1px solid rgba(0,0,0,0.15);
      border-radius: 6px;
      font-size: 13px;
      outline: none;
      font-family: inherit;
    }
    .tng-input:focus { border-color: ${ORANGE}; }

    .tng-meta { padding: 4px 14px; font-size: 11px; opacity: 0.6; }

    .tng-results { overflow-y: auto; flex: 1; }
    .tng-result {
      padding: 10px 14px;
      border-bottom: 1px solid rgba(0,0,0,0.06);
      cursor: pointer;
      transition: background 80ms ease;
    }
    .tng-result:hover { background: rgba(204,85,0,0.08); }
    .tng-result-title { font-weight: 600; font-size: 13px; margin-bottom: 2px; }
    .tng-result-snippet { font-size: 12px; opacity: 0.75; line-height: 1.4; }

    .tng-empty { padding: 20px 14px; font-size: 12px; opacity: 0.6; text-align: center; }

    .tng-banner {
      padding: 8px 14px;
      background: #fff4e6;
      color: #8a4500;
      font-size: 12px;
      border-bottom: 1px solid rgba(0,0,0,0.06);
    }
    .tng-banner a { color: ${ORANGE}; font-weight: 600; }
  `;
  document.head.appendChild(style);
}

interface OverlayState {
  panelEl?: HTMLDivElement;
  btnEl?: HTMLButtonElement;
  attachedTextarea?: HTMLElement;
  searchTimer?: ReturnType<typeof setTimeout>;
  appReachable: boolean;
}

const state: OverlayState = { appReachable: false };

/**
 * Create or update the floating 🍊 button positioned near `textarea`.
 * Returns the button element. Idempotent — call any time the textarea reference
 * changes (e.g. SPA navigation).
 */
export function attachButton(textarea: HTMLElement, deps: OverlayDeps): HTMLButtonElement {
  injectStylesOnce();

  let btn = document.getElementById(BTN_ID) as HTMLButtonElement | null;
  if (!btn) {
    btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.type = 'button';
    btn.title = 'Inject Tangerine team memory';
    btn.textContent = '🍊';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      togglePanel(deps);
    });
    document.body.appendChild(btn);
  }

  state.btnEl = btn;
  state.attachedTextarea = textarea;
  positionButton(btn, textarea);

  // Reposition on scroll/resize. Throttled via rAF.
  if (!(window as any).__tngBound) {
    (window as any).__tngBound = true;
    let pending = false;
    const reposition = () => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        if (state.btnEl && state.attachedTextarea && document.contains(state.attachedTextarea)) {
          positionButton(state.btnEl, state.attachedTextarea);
        }
        if (state.panelEl && state.attachedTextarea && document.contains(state.attachedTextarea)) {
          positionPanel(state.panelEl, state.attachedTextarea);
        }
      });
    };
    window.addEventListener('scroll', reposition, { passive: true, capture: true });
    window.addEventListener('resize', reposition, { passive: true });
  }

  return btn;
}

function positionButton(btn: HTMLButtonElement, textarea: HTMLElement) {
  const rect = textarea.getBoundingClientRect();
  // Bottom-right of textarea, with small inset.
  const top = rect.bottom - 36;
  const left = rect.right - 36;
  btn.style.top = `${Math.max(8, top)}px`;
  btn.style.left = `${Math.max(8, left)}px`;
}

function positionPanel(panel: HTMLDivElement, textarea: HTMLElement) {
  const rect = textarea.getBoundingClientRect();
  // Anchor above the textarea, right-aligned with the 🍊 button.
  const panelWidth = 480;
  const panelHeight = panel.offsetHeight || 320;
  let top = rect.top - panelHeight - 12;
  if (top < 8) top = rect.bottom + 12;
  let left = rect.right - panelWidth;
  if (left < 8) left = 8;
  panel.style.top = `${top}px`;
  panel.style.left = `${left}px`;
}

async function togglePanel(deps: OverlayDeps) {
  const existing = document.getElementById(PANEL_ID) as HTMLDivElement | null;
  if (existing) {
    closePanel();
    return;
  }
  await openPanel(deps);
}

async function openPanel(deps: OverlayDeps) {
  injectStylesOnce();
  const panel = document.createElement('div');
  panel.id = PANEL_ID;

  // Header.
  const header = document.createElement('div');
  header.className = 'tng-header';
  const title = document.createElement('div');
  title.className = 'tng-header-title';
  title.textContent = '🍊 Tangerine memory';
  const close = document.createElement('button');
  close.className = 'tng-header-close';
  close.textContent = '×';
  close.title = 'Close';
  close.addEventListener('click', closePanel);
  header.appendChild(title);
  header.appendChild(close);
  panel.appendChild(header);

  // Reachability banner placeholder; populated below.
  const bannerSlot = document.createElement('div');
  panel.appendChild(bannerSlot);

  // Input.
  const inputWrap = document.createElement('div');
  inputWrap.className = 'tng-input-wrap';
  const input = document.createElement('input');
  input.className = 'tng-input';
  input.type = 'text';
  input.placeholder = 'Search team memory…';
  inputWrap.appendChild(input);
  panel.appendChild(inputWrap);

  const meta = document.createElement('div');
  meta.className = 'tng-meta';
  panel.appendChild(meta);

  const results = document.createElement('div');
  results.className = 'tng-results';
  panel.appendChild(results);

  document.body.appendChild(panel);
  state.panelEl = panel;

  if (state.attachedTextarea) {
    positionPanel(panel, state.attachedTextarea);
  }

  requestAnimationFrame(() => panel.classList.add('tng-open'));

  // Outside click to close.
  setTimeout(() => {
    document.addEventListener('mousedown', outsideClickHandler);
    document.addEventListener('keydown', escHandler);
  }, 0);

  // Reachability check (non-blocking).
  deps
    .ping()
    .then((reachable) => {
      state.appReachable = reachable;
      if (!reachable) {
        const banner = document.createElement('div');
        banner.className = 'tng-banner';
        banner.innerHTML =
          'Tangerine app not running. <a href="https://github.com/tangerine-intelligence/meeting-live#install" target="_blank" rel="noopener">Install →</a>';
        bannerSlot.appendChild(banner);
      }
    })
    .catch(() => {
      /* swallow — banner just won't show */
    });

  // Seed query from textarea.
  const seed = extractQueryFromTextarea(deps.readTextarea());
  input.value = seed;

  const runSearch = async () => {
    const q = input.value.trim();
    if (!q) {
      results.innerHTML = '';
      meta.textContent = '';
      return;
    }
    meta.textContent = 'Searching…';
    const items = await deps.search(q);
    renderResults(results, meta, items, deps);
  };

  input.addEventListener('input', () => {
    if (state.searchTimer) clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(runSearch, 200);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      runSearch();
    }
  });

  input.focus();
  if (seed) {
    input.select();
    runSearch();
  }
}

function renderResults(
  container: HTMLElement,
  meta: HTMLElement,
  items: MemoryResult[],
  deps: OverlayDeps
) {
  container.innerHTML = '';
  if (items.length === 0) {
    meta.textContent = '';
    const empty = document.createElement('div');
    empty.className = 'tng-empty';
    empty.textContent = state.appReachable
      ? 'No matching memory found.'
      : 'No results — Tangerine app may not be running.';
    container.appendChild(empty);
    return;
  }
  meta.textContent = `${items.length} result${items.length === 1 ? '' : 's'} — click to inject`;
  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'tng-result';
    const titleEl = document.createElement('div');
    titleEl.className = 'tng-result-title';
    titleEl.textContent = item.title;
    const snip = document.createElement('div');
    snip.className = 'tng-result-snippet';
    snip.textContent = item.snippet;
    row.appendChild(titleEl);
    row.appendChild(snip);
    row.addEventListener('click', () => {
      deps.inject(formatResultForInjection(item));
      closePanel();
    });
    container.appendChild(row);
  }
}

function outsideClickHandler(e: MouseEvent) {
  const panel = document.getElementById(PANEL_ID);
  const btn = document.getElementById(BTN_ID);
  if (!panel) return;
  const target = e.target as Node;
  if (panel.contains(target) || (btn && btn.contains(target))) return;
  closePanel();
}

function escHandler(e: KeyboardEvent) {
  if (e.key === 'Escape') closePanel();
}

function closePanel() {
  document.removeEventListener('mousedown', outsideClickHandler);
  document.removeEventListener('keydown', escHandler);
  const panel = document.getElementById(PANEL_ID);
  if (!panel) return;
  panel.classList.remove('tng-open');
  setTimeout(() => panel.remove(), 150);
  state.panelEl = undefined;
}

/**
 * Watch the DOM for a textarea matching `selector` and (re)attach the button.
 * Most AI sites are SPAs — the textarea is removed/recreated on navigation.
 */
export function watchForTextarea(
  selectorFn: () => HTMLElement | null,
  deps: OverlayDeps
) {
  const tryAttach = () => {
    const ta = selectorFn();
    if (ta && ta !== state.attachedTextarea) {
      attachButton(ta, deps);
    } else if (ta && state.btnEl) {
      // Reposition in case textarea moved.
      positionButton(state.btnEl, ta);
    } else if (!ta && state.btnEl) {
      // Textarea gone (e.g. logged out) — remove button.
      state.btnEl.remove();
      state.btnEl = undefined;
      state.attachedTextarea = undefined;
    }
  };

  tryAttach();
  const obs = new MutationObserver(() => tryAttach());
  obs.observe(document.body, { childList: true, subtree: true });
  // Also poll every 2s as a safety net for sites that mount without DOM mutations.
  setInterval(tryAttach, 2000);
}
