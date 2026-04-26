/**
 * Shared types for Tangerine browser extension.
 *
 * Wire protocol over ws://127.0.0.1:7780/memory:
 *   client → server: SearchRequest
 *   server → client: SearchResponse
 * Same shape as the Tangerine MCP server tool response so the desktop app can
 * proxy directly to its memory store.
 */

export interface SearchRequest {
  op: 'search';
  query: string;
  limit?: number;
}

export interface FileRequest {
  op: 'file';
  path: string;
}

export type ClientRequest = SearchRequest | FileRequest;

export interface MemoryResult {
  /** Absolute path to the source memory file. */
  file: string;
  /** Display title (usually H1 or filename). */
  title: string;
  /** Short matched snippet (~200 chars). */
  snippet: string;
  /** Longer preview pasted into the AI prompt (~1500 chars). */
  preview: string;
  /** Relevance score 0..1. Higher is better. */
  score?: number;
}

export interface SearchResponse {
  op: 'search.result';
  results: MemoryResult[];
  /** Server-reported elapsed time in ms (best-effort). */
  tookMs?: number;
}

export interface FileResponse {
  op: 'file.result';
  path: string;
  content: string;
}

export interface ErrorResponse {
  op: 'error';
  code:
    | 'unreachable'
    | 'timeout'
    | 'invalid_request'
    | 'not_found'
    | 'internal';
  message: string;
}

export type ServerResponse = SearchResponse | FileResponse | ErrorResponse;

/** Stored in chrome.storage.sync. */
export interface ExtensionSettings {
  /** Localhost websocket endpoint for Tangerine desktop app. */
  endpoint: string;
  /** Enabled site list (matched against window.location.hostname). */
  enabledSites: {
    chatgpt: boolean;
    claude: boolean;
    gemini: boolean;
  };
  /** Default number of results to fetch. */
  resultLimit: number;
  /** Auto-prefill the search query from textarea content. */
  autoPrefill: boolean;
}

export const DEFAULT_SETTINGS: ExtensionSettings = {
  endpoint: 'ws://127.0.0.1:7780/memory',
  enabledSites: { chatgpt: true, claude: true, gemini: true },
  resultLimit: 5,
  autoPrefill: true,
};

/** Background ↔ content script bridge messages. */
export interface BridgeMessage {
  type: 'memory.search' | 'memory.file' | 'memory.status';
  payload?: unknown;
}

export interface BridgeResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}
