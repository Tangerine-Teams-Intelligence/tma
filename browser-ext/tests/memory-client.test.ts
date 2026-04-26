/**
 * Unit tests for MemoryClient with a fake WebSocket.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  MemoryClient,
  extractQueryFromTextarea,
  formatResultForInjection,
} from '../src/shared/memory-client';
import type { MemoryResult, ServerResponse } from '../src/shared/types';

type Listener = (event: any) => void;

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  url: string;
  readyState = 0;
  listeners: Record<string, Listener[]> = {};
  sent: string[] = [];

  // The next response to deliver after `send`. Tests set this.
  static nextResponse: ServerResponse | null = null;
  static failOnConstruct = false;
  static failOnOpen = false;
  static silent = false;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
    if (FakeWebSocket.failOnConstruct) {
      throw new Error('boom');
    }
    queueMicrotask(() => {
      if (FakeWebSocket.failOnOpen) {
        this.readyState = 3;
        this.dispatch('error', {});
        this.dispatch('close', { code: 1006 });
        return;
      }
      this.readyState = 1;
      this.dispatch('open', {});
    });
  }

  addEventListener(type: string, fn: Listener) {
    (this.listeners[type] ??= []).push(fn);
  }

  send(data: string) {
    this.sent.push(data);
    if (FakeWebSocket.silent) return;
    queueMicrotask(() => {
      const resp = FakeWebSocket.nextResponse;
      if (resp) {
        this.dispatch('message', { data: JSON.stringify(resp) });
      }
    });
  }

  close() {
    this.readyState = 3;
    this.dispatch('close', { code: 1000 });
  }

  private dispatch(type: string, ev: any) {
    for (const fn of this.listeners[type] ?? []) fn(ev);
  }
}

function reset() {
  FakeWebSocket.instances = [];
  FakeWebSocket.nextResponse = null;
  FakeWebSocket.failOnConstruct = false;
  FakeWebSocket.failOnOpen = false;
  FakeWebSocket.silent = false;
}

describe('MemoryClient', () => {
  it('returns results from a successful search', async () => {
    reset();
    const result: MemoryResult = {
      file: '/mem/note.md',
      title: 'Note',
      snippet: 'snip',
      preview: 'preview body',
    };
    FakeWebSocket.nextResponse = { op: 'search.result', results: [result], tookMs: 12 };
    const c = new MemoryClient({
      endpoint: 'ws://x',
      webSocketCtor: FakeWebSocket as unknown as typeof WebSocket,
      timeoutMs: 500,
    });
    const out = await c.search('hello', 3);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.results).toHaveLength(1);
      expect(out.results[0].title).toBe('Note');
      expect(out.tookMs).toBe(12);
    }
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(JSON.parse(FakeWebSocket.instances[0].sent[0])).toEqual({
      op: 'search',
      query: 'hello',
      limit: 3,
    });
  });

  it('returns empty results for empty query without opening socket', async () => {
    reset();
    const c = new MemoryClient({
      endpoint: 'ws://x',
      webSocketCtor: FakeWebSocket as unknown as typeof WebSocket,
    });
    const out = await c.search('   ');
    expect(out).toEqual({ ok: true, results: [] });
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('reports unreachable when constructor throws', async () => {
    reset();
    FakeWebSocket.failOnConstruct = true;
    const c = new MemoryClient({
      endpoint: 'ws://x',
      webSocketCtor: FakeWebSocket as unknown as typeof WebSocket,
    });
    const out = await c.search('q');
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe('unreachable');
  });

  it('reports unreachable on socket error', async () => {
    reset();
    FakeWebSocket.failOnOpen = true;
    const c = new MemoryClient({
      endpoint: 'ws://x',
      webSocketCtor: FakeWebSocket as unknown as typeof WebSocket,
      timeoutMs: 200,
    });
    const out = await c.search('q');
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe('unreachable');
  });

  it('times out if no response arrives', async () => {
    reset();
    FakeWebSocket.silent = true;
    const c = new MemoryClient({
      endpoint: 'ws://x',
      webSocketCtor: FakeWebSocket as unknown as typeof WebSocket,
      timeoutMs: 30,
    });
    const out = await c.search('q');
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe('timeout');
  });

  it('relays server-reported errors', async () => {
    reset();
    FakeWebSocket.nextResponse = {
      op: 'error',
      code: 'not_found',
      message: 'memory empty',
    };
    const c = new MemoryClient({
      endpoint: 'ws://x',
      webSocketCtor: FakeWebSocket as unknown as typeof WebSocket,
    });
    const out = await c.search('q');
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.code).toBe('not_found');
      expect(out.message).toBe('memory empty');
    }
  });

  it('ping returns ok when search succeeds', async () => {
    reset();
    FakeWebSocket.nextResponse = { op: 'search.result', results: [] };
    const c = new MemoryClient({
      endpoint: 'ws://x',
      webSocketCtor: FakeWebSocket as unknown as typeof WebSocket,
    });
    const r = await c.ping();
    expect(r.ok).toBe(true);
  });

  it('ping returns not-ok when unreachable', async () => {
    reset();
    FakeWebSocket.failOnConstruct = true;
    const c = new MemoryClient({
      endpoint: 'ws://x',
      webSocketCtor: FakeWebSocket as unknown as typeof WebSocket,
    });
    const r = await c.ping();
    expect(r.ok).toBe(false);
  });

  it('file() returns content on file.result', async () => {
    reset();
    FakeWebSocket.nextResponse = {
      op: 'file.result',
      path: '/x.md',
      content: 'hello world',
    };
    const c = new MemoryClient({
      endpoint: 'ws://x',
      webSocketCtor: FakeWebSocket as unknown as typeof WebSocket,
    });
    const out = await c.file('/x.md');
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.content).toBe('hello world');
      expect(out.path).toBe('/x.md');
    }
  });
});

describe('formatResultForInjection', () => {
  it('produces a markdown header + preview + path', () => {
    const r: MemoryResult = {
      file: '/notes/2026-04-25.md',
      title: '2026-04-25 David sync',
      snippet: 'short snippet',
      preview: 'longer preview body across\nmultiple lines',
    };
    const formatted = formatResultForInjection(r);
    expect(formatted).toContain('## From: 2026-04-25 David sync');
    expect(formatted).toContain('longer preview body across');
    expect(formatted).toContain('More: /notes/2026-04-25.md');
  });

  it('falls back to snippet when preview missing', () => {
    const r: MemoryResult = {
      file: '/x.md',
      title: 't',
      snippet: 'just snippet',
      preview: '',
    };
    const formatted = formatResultForInjection(r);
    expect(formatted).toContain('just snippet');
  });
});

describe('extractQueryFromTextarea', () => {
  it('returns last sentence', () => {
    const out = extractQueryFromTextarea(
      'We talked about Postgres earlier. We should use Postgres for v1.'
    );
    expect(out).toBe('We should use Postgres for v1.');
  });

  it('strips code fences', () => {
    const out = extractQueryFromTextarea('```js\nconsole.log(1)\n```\nuse postgres');
    expect(out).toBe('use postgres');
  });

  it('truncates very long input to last 120 chars', () => {
    const long = 'a'.repeat(500);
    const out = extractQueryFromTextarea(long);
    expect(out.length).toBe(120);
  });

  it('handles empty input', () => {
    expect(extractQueryFromTextarea('')).toBe('');
    expect(extractQueryFromTextarea('   ')).toBe('');
  });
});
