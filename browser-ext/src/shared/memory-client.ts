/**
 * MemoryClient — talks to the Tangerine desktop app over localhost websocket.
 *
 * Cleanly degrades when the desktop app is not running:
 *   - search() resolves with { ok: false, code: 'unreachable' }
 *   - never throws to the caller
 *
 * Path A (this file): ws://127.0.0.1:7780/memory.
 * Path B (v1.6.1): bundled local snapshot via chrome.storage. See README.
 */

import type {
  AgiEnvelope,
  ClientRequest,
  ErrorResponse,
  FileRequest,
  FileResponse,
  MemoryResult,
  SearchRequest,
  SearchResponse,
  ServerResponse,
} from './types';

export interface SearchOk {
  ok: true;
  results: MemoryResult[];
  tookMs?: number;
  /**
   * Stage 1 AGI envelope from the desktop app (Hook 4). Optional — older
   * desktop apps don't include it. UI surfaces confidence as a small badge
   * ("⭐ confident" Stage 1 always, "🤔 uncertain" Stage 2 when < threshold).
   */
  envelope?: AgiEnvelope;
}

export interface SearchErr {
  ok: false;
  code: ErrorResponse['code'];
  message: string;
}

export type SearchOutcome = SearchOk | SearchErr;

export interface FileOk {
  ok: true;
  path: string;
  content: string;
}

export type FileOutcome = FileOk | SearchErr;

export interface MemoryClientOptions {
  endpoint: string;
  /** Per-request timeout in ms. */
  timeoutMs?: number;
  /** Inject a custom WebSocket constructor (used by tests). */
  webSocketCtor?: typeof WebSocket;
}

interface PendingRequest {
  resolve: (value: ServerResponse) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

let nextRequestId = 1;

export class MemoryClient {
  private endpoint: string;
  private timeoutMs: number;
  private WS: typeof WebSocket;

  constructor(opts: MemoryClientOptions) {
    this.endpoint = opts.endpoint;
    this.timeoutMs = opts.timeoutMs ?? 4000;
    this.WS = opts.webSocketCtor ?? WebSocket;
  }

  /**
   * Search memory. Always resolves; never rejects.
   */
  async search(query: string, limit = 5): Promise<SearchOutcome> {
    const req: SearchRequest = { op: 'search', query: query.trim(), limit };
    if (!req.query) {
      return { ok: true, results: [] };
    }
    const out = await this.sendOnce(req);
    if (!out.ok) return out;
    if (out.response.op === 'search.result') {
      return {
        ok: true,
        results: out.response.results ?? [],
        tookMs: out.response.tookMs,
        envelope: out.response.envelope,
      };
    }
    if (out.response.op === 'error') {
      return {
        ok: false,
        code: out.response.code,
        message: out.response.message,
      };
    }
    return { ok: false, code: 'internal', message: 'unexpected response op' };
  }

  /**
   * Fetch a full memory file.
   */
  async file(path: string): Promise<FileOutcome> {
    const req: FileRequest = { op: 'file', path };
    const out = await this.sendOnce(req);
    if (!out.ok) return out;
    if (out.response.op === 'file.result') {
      return { ok: true, path: out.response.path, content: out.response.content };
    }
    if (out.response.op === 'error') {
      return { ok: false, code: out.response.code, message: out.response.message };
    }
    return { ok: false, code: 'internal', message: 'unexpected response op' };
  }

  /**
   * Probe whether the desktop app is reachable. Cheap.
   *
   * Sends a real search request (not the empty-query shortcut) so we exercise
   * the actual websocket round-trip. `unreachable` and `timeout` map to false;
   * anything else (including server errors) maps to true since the socket itself
   * worked.
   */
  async ping(): Promise<{ ok: boolean }> {
    const out = await this.sendOnce({ op: 'search', query: '__ping__', limit: 1 });
    if (out.ok) return { ok: true };
    if (out.code === 'unreachable' || out.code === 'timeout') return { ok: false };
    return { ok: true };
  }

  /**
   * Open one ws connection, send one request, await one response, close.
   * Simpler than connection pooling for v0.1; the round-trip is cheap on localhost.
   */
  private sendOnce(
    req: ClientRequest
  ): Promise<
    | { ok: true; response: ServerResponse }
    | { ok: false; code: ErrorResponse['code']; message: string }
  > {
    return new Promise((resolve) => {
      let socket: WebSocket;
      try {
        socket = new this.WS(this.endpoint);
      } catch (err) {
        resolve({
          ok: false,
          code: 'unreachable',
          message: `Could not open websocket: ${(err as Error).message}`,
        });
        return;
      }

      const reqId = nextRequestId++;

      let settled = false;
      const settle = (
        result:
          | { ok: true; response: ServerResponse }
          | { ok: false; code: ErrorResponse['code']; message: string }
      ) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // IMPORTANT: resolve before close. Closing the socket fires a 'close'
        // event synchronously in some implementations; if we resolved after,
        // the handler could race and overwrite our outcome.
        resolve(result);
        try {
          socket.close();
        } catch {
          /* ignore */
        }
      };

      const timer = setTimeout(() => {
        settle({
          ok: false,
          code: 'timeout',
          message: `Request ${reqId} timed out after ${this.timeoutMs}ms`,
        });
      }, this.timeoutMs);

      socket.addEventListener('open', () => {
        try {
          socket.send(JSON.stringify(req));
        } catch (err) {
          settle({
            ok: false,
            code: 'internal',
            message: `Send failed: ${(err as Error).message}`,
          });
        }
      });

      socket.addEventListener('message', (event: MessageEvent) => {
        try {
          const data =
            typeof event.data === 'string' ? event.data : String(event.data);
          const parsed = JSON.parse(data) as ServerResponse;
          settle({ ok: true, response: parsed });
        } catch (err) {
          settle({
            ok: false,
            code: 'internal',
            message: `Parse failed: ${(err as Error).message}`,
          });
        }
      });

      socket.addEventListener('error', () => {
        settle({
          ok: false,
          code: 'unreachable',
          message: 'Tangerine app not reachable on ' + this.endpoint,
        });
      });

      socket.addEventListener('close', (event: CloseEvent) => {
        if (!settled) {
          settle({
            ok: false,
            code: 'unreachable',
            message: `Socket closed before response (code ${event.code})`,
          });
        }
      });
    });
  }
}

/**
 * Render the confidence value from an AGI envelope as a tiny badge string.
 * Stage 1 always returns "⭐ confident" because the desktop app pins
 * confidence at 1.0. Stage 2 will start emitting < 1.0 and we'll surface
 * "🤔 uncertain" / hide the chip below threshold.
 */
export function confidenceBadge(envelope: AgiEnvelope | undefined): string {
  if (!envelope) return '';
  const c = typeof envelope.confidence === 'number' ? envelope.confidence : 1.0;
  if (c >= 0.8) return '⭐ confident';
  if (c >= 0.5) return '· likely';
  return '🤔 uncertain';
}

/**
 * Format a memory result for injection into the AI prompt textarea.
 * Format chosen to be both human-skimmable and LLM-friendly.
 */
export function formatResultForInjection(r: MemoryResult): string {
  const parts: string[] = [];
  parts.push(`## From: ${r.title}`);
  parts.push('');
  parts.push(r.preview || r.snippet);
  parts.push('');
  parts.push(`More: ${r.file}`);
  parts.push('');
  return parts.join('\n');
}

/**
 * Extract a search query from raw textarea content. Naive but works:
 *   - take the last sentence (or last 120 chars if no sentence terminator)
 *   - strip code fences and whitespace
 */
export function extractQueryFromTextarea(text: string): string {
  if (!text) return '';
  let s = text.replace(/```[\s\S]*?```/g, ' ').trim();
  if (!s) return '';
  const sentences = s.split(/(?<=[.!?。！？])\s+/);
  s = sentences[sentences.length - 1] ?? s;
  if (s.length > 120) s = s.slice(-120);
  return s.trim();
}
