/**
 * smart-chip.ts — proactive injector chip + watcher.
 *
 * When `smartInject` is on (chrome.storage.sync), we attach a 1.5s-debounced
 * input watcher to the host site's textarea. Each tick:
 *   1. read textarea contents
 *   2. apply isQuestionLike heuristic
 *   3. skip if dismissed for this session
 *   4. silent ws search via the background bridge
 *   5. if results: render a small floating chip near the textarea with
 *      a dropdown of snippets; click "Inject all" to prepend them
 *   6. dismiss button hides the chip for that prompt for the rest of session
 *
 * The chip is intentionally subtle — small, low z-index relative to host
 * dialogs, never auto-injects. User retains control.
 */

import type { MemoryResult, AgiEnvelope } from '../shared/types';
import {
  DEBOUNCE_MS,
  SmartInjectMemo,
  isQuestionLike,
  makeDebouncer,
  shouldShowChip,
} from '../shared/smart-inject';
import { confidenceBadge, formatResultForInjection } from '../shared/memory-client';

export interface SmartChipDeps {
  /**
   * Run a memory search. Returns results + (Stage 1) optional envelope. The
   * watcher swallows errors and returns [].
   */
  search: (query: string) => Promise<{ results: MemoryResult[]; envelope?: AgiEnvelope }>;
  /** Inject text into the host site's prompt area. */
  inject: (text: string) => void;
  /** Read current textarea contents. Empty string if not found. */
  readTextarea: () => string;
  /** Locate the textarea so we can position the chip relative to it. */
  findTextarea: () => HTMLElement | null;
}

const CHIP_ID = 'tng-smart-chip';
const DROPDOWN_ID = 'tng-smart-chip-dropdown';
const STYLE_ID = 'tng-smart-chip-styles';

const ORANGE = '#CC5500';
const NAVY = '#1A1A2E';

function injectStylesOnce() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    #${CHIP_ID} {
      position: fixed;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px 4px 8px;
      background: white;
      color: ${NAVY};
      border: 1px solid ${ORANGE};
      border-radius: 999px;
      font-family: -apple-system, system-ui, "Segoe UI", sans-serif;
      font-size: 11px;
      line-height: 1.4;
      cursor: pointer;
      z-index: 2147483645;
      box-shadow: 0 2px 6px rgba(0,0,0,0.12);
      opacity: 0;
      transform: translateY(4px);
      transition: opacity 120ms ease, transform 120ms ease;
      user-select: none;
    }
    #${CHIP_ID}.tng-chip-show {
      opacity: 1;
      transform: translateY(0);
    }
    #${CHIP_ID} .tng-chip-icon { font-size: 13px; }
    #${CHIP_ID} .tng-chip-text { font-weight: 600; }
    #${CHIP_ID} .tng-chip-conf { opacity: 0.65; font-weight: 400; margin-left: 2px; font-size: 10px; }
    #${CHIP_ID} .tng-chip-x {
      cursor: pointer;
      padding: 0 4px;
      opacity: 0.5;
      font-weight: 700;
      margin-left: 2px;
    }
    #${CHIP_ID} .tng-chip-x:hover { opacity: 1; color: ${ORANGE}; }

    #${DROPDOWN_ID} {
      position: fixed;
      width: 380px;
      max-width: calc(100vw - 32px);
      max-height: 280px;
      overflow-y: auto;
      background: white;
      color: ${NAVY};
      border: 1px solid rgba(0,0,0,0.1);
      border-radius: 8px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.18);
      z-index: 2147483646;
      font-family: -apple-system, system-ui, "Segoe UI", sans-serif;
      font-size: 12px;
      padding: 0;
      display: none;
    }
    #${DROPDOWN_ID}.tng-dd-show { display: block; }
    @media (prefers-color-scheme: dark) {
      #${CHIP_ID} { background: #1f1f23; color: #ececec; }
      #${DROPDOWN_ID} { background: #1f1f23; color: #ececec; border-color: #2a2a30; }
      .tng-dd-row:hover { background: #28282e !important; }
      .tng-dd-row { border-bottom-color: #2a2a30 !important; }
    }
    .tng-dd-head {
      padding: 8px 12px;
      border-bottom: 1px solid rgba(0,0,0,0.06);
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .tng-dd-head-title { font-weight: 600; flex: 1; }
    .tng-dd-inject {
      background: ${ORANGE}; color: white;
      border: none; border-radius: 4px; padding: 4px 10px;
      font-size: 11px; font-weight: 600; cursor: pointer;
      font-family: inherit;
    }
    .tng-dd-inject:hover { opacity: 0.9; }
    .tng-dd-row {
      padding: 8px 12px;
      border-bottom: 1px solid rgba(0,0,0,0.06);
    }
    .tng-dd-row:last-child { border-bottom: none; }
    .tng-dd-title { font-weight: 600; font-size: 12px; margin-bottom: 2px; }
    .tng-dd-snippet { font-size: 11px; opacity: 0.75; line-height: 1.4; }
  `;
  document.head.appendChild(style);
}

interface ChipState {
  chip?: HTMLElement;
  dropdown?: HTMLElement;
  lastResults: MemoryResult[];
  lastEnvelope?: AgiEnvelope;
  lastQuery: string;
  attached: boolean;
}

const state: ChipState = {
  lastResults: [],
  lastQuery: '',
  attached: false,
};

const memo = new SmartInjectMemo();

export function getSmartInjectMemo(): SmartInjectMemo {
  return memo;
}

/**
 * Start (or restart) the smart-inject watcher. Idempotent — calling twice
 * just resets the debouncer. Pass `enabled=false` to tear down.
 */
export function setSmartInjectEnabled(enabled: boolean, deps: SmartChipDeps): void {
  if (enabled) {
    if (!state.attached) attachWatcher(deps);
  } else {
    detach();
  }
}

function attachWatcher(deps: SmartChipDeps): void {
  injectStylesOnce();
  state.attached = true;

  const tick = makeDebouncer<string>(DEBOUNCE_MS, async (text) => {
    if (!isQuestionLike(text)) {
      hideChip();
      return;
    }
    if (memo.isDismissed(text)) {
      hideChip();
      return;
    }
    let outcome: { results: MemoryResult[]; envelope?: AgiEnvelope };
    try {
      outcome = await deps.search(text);
    } catch {
      hideChip();
      return;
    }
    if (!shouldShowChip(outcome.results)) {
      hideChip();
      return;
    }
    state.lastResults = outcome.results;
    state.lastEnvelope = outcome.envelope;
    state.lastQuery = text;
    showChip(outcome.results.length, outcome.envelope, deps);
  });

  // Listen on input + keyup so we cover both keyboard and paste.
  const handler = () => {
    const text = deps.readTextarea();
    tick(text);
  };
  // We attach to the document, not the textarea — host SPAs may swap the
  // textarea node out from under us. Bubble-phase input events catch all.
  document.addEventListener('input', handler, true);
  document.addEventListener('keyup', handler, true);
  (state as any)._handler = handler;
}

function detach(): void {
  state.attached = false;
  hideChip();
  hideDropdown();
  const h = (state as any)._handler;
  if (h) {
    document.removeEventListener('input', h, true);
    document.removeEventListener('keyup', h, true);
    (state as any)._handler = null;
  }
}

function showChip(count: number, envelope: AgiEnvelope | undefined, deps: SmartChipDeps): void {
  injectStylesOnce();
  const ta = deps.findTextarea();
  if (!ta) {
    hideChip();
    return;
  }
  let chip = document.getElementById(CHIP_ID) as HTMLElement | null;
  if (!chip) {
    chip = document.createElement('div');
    chip.id = CHIP_ID;
    chip.title = 'Tangerine found relevant team memory';
    document.body.appendChild(chip);
  }
  const badge = confidenceBadge(envelope);
  chip.innerHTML = '';
  const icon = document.createElement('span');
  icon.className = 'tng-chip-icon';
  icon.textContent = '🍊';
  const txt = document.createElement('span');
  txt.className = 'tng-chip-text';
  txt.textContent = `${count} relevant ${count === 1 ? 'memory' : 'memories'}`;
  const conf = document.createElement('span');
  conf.className = 'tng-chip-conf';
  conf.textContent = badge;
  const x = document.createElement('span');
  x.className = 'tng-chip-x';
  x.textContent = '×';
  x.title = 'Dismiss';
  x.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    memo.dismiss(state.lastQuery);
    hideChip();
    hideDropdown();
  });
  chip.appendChild(icon);
  chip.appendChild(txt);
  if (badge) chip.appendChild(conf);
  chip.appendChild(x);
  chip.addEventListener('mouseenter', () => showDropdown(deps));
  chip.addEventListener('click', (e) => {
    if (e.target === x) return;
    showDropdown(deps);
  });

  positionChip(chip, ta);
  requestAnimationFrame(() => chip!.classList.add('tng-chip-show'));
  state.chip = chip;
}

function hideChip(): void {
  const chip = document.getElementById(CHIP_ID);
  if (!chip) return;
  chip.classList.remove('tng-chip-show');
  chip.remove();
  state.chip = undefined;
}

function showDropdown(deps: SmartChipDeps): void {
  injectStylesOnce();
  const ta = deps.findTextarea();
  if (!ta) return;
  let dd = document.getElementById(DROPDOWN_ID) as HTMLElement | null;
  if (!dd) {
    dd = document.createElement('div');
    dd.id = DROPDOWN_ID;
    document.body.appendChild(dd);
  }
  dd.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'tng-dd-head';
  const title = document.createElement('span');
  title.className = 'tng-dd-head-title';
  title.textContent = `🍊 ${state.lastResults.length} relevant ${state.lastResults.length === 1 ? 'memory' : 'memories'}`;
  const inj = document.createElement('button');
  inj.className = 'tng-dd-inject';
  inj.textContent = 'Inject all';
  inj.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const text = state.lastResults
      .map((r) => formatResultForInjection(r))
      .join('\n');
    deps.inject(text);
    memo.dismiss(state.lastQuery);
    hideChip();
    hideDropdown();
  });
  head.appendChild(title);
  head.appendChild(inj);
  dd.appendChild(head);

  for (const r of state.lastResults.slice(0, 8)) {
    const row = document.createElement('div');
    row.className = 'tng-dd-row';
    const t = document.createElement('div');
    t.className = 'tng-dd-title';
    t.textContent = r.title;
    const s = document.createElement('div');
    s.className = 'tng-dd-snippet';
    s.textContent = r.snippet;
    row.appendChild(t);
    row.appendChild(s);
    dd.appendChild(row);
  }
  positionDropdown(dd, ta);
  dd.classList.add('tng-dd-show');
  state.dropdown = dd;

  // Hide on outside click. Using setTimeout so the opening click doesn't trigger.
  setTimeout(() => document.addEventListener('mousedown', outsideClickToHide, { once: true }), 50);
}

function outsideClickToHide(e: MouseEvent): void {
  const dd = document.getElementById(DROPDOWN_ID);
  const chip = document.getElementById(CHIP_ID);
  const target = e.target as Node;
  if (dd && dd.contains(target)) return;
  if (chip && chip.contains(target)) return;
  hideDropdown();
}

function hideDropdown(): void {
  const dd = document.getElementById(DROPDOWN_ID);
  if (!dd) return;
  dd.classList.remove('tng-dd-show');
  dd.remove();
  state.dropdown = undefined;
}

function positionChip(chip: HTMLElement, ta: HTMLElement): void {
  const rect = ta.getBoundingClientRect();
  // Just above the textarea, left-aligned with its left edge so it doesn't
  // cover the 🍊 manual button (which sits bottom-right of the textarea).
  const top = Math.max(8, rect.top - 28);
  const left = Math.max(8, rect.left);
  chip.style.top = `${top}px`;
  chip.style.left = `${left}px`;
}

function positionDropdown(dd: HTMLElement, ta: HTMLElement): void {
  const rect = ta.getBoundingClientRect();
  const ddWidth = 380;
  const top = Math.max(8, rect.top - 280 - 8);
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - ddWidth - 8));
  dd.style.top = `${top}px`;
  dd.style.left = `${left}px`;
}
