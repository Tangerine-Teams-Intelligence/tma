/**
 * envelope.test.ts — confidence-badge helper + envelope passthrough on the
 * memory client. Stage 1 Hook 4.
 */

import { describe, expect, it } from 'vitest';
import { MemoryClient, confidenceBadge } from '../src/shared/memory-client';
import type { AgiEnvelope, ServerResponse } from '../src/shared/types';

type Listener = (event: any) => void;

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  url: string;
  readyState = 0;
  listeners: Record<string, Listener[]> = {};
  sent: string[] = [];
  static nextResponse: ServerResponse | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.dispatch('open', {});
    });
  }
  addEventListener(type: string, fn: Listener) {
    (this.listeners[type] ??= []).push(fn);
  }
  send(data: string) {
    this.sent.push(data);
    queueMicrotask(() => {
      const resp = FakeWebSocket.nextResponse;
      if (resp) this.dispatch('message', { data: JSON.stringify(resp) });
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

const ENV: AgiEnvelope = {
  data: undefined,
  confidence: 1.0,
  freshness_seconds: 60,
  source_atoms: ['evt-2026-04-25-aaaaaaaaaa'],
  alternatives: [],
  reasoning_notes: null,
};

describe('confidenceBadge', () => {
  it('returns empty string for missing envelope', () => {
    expect(confidenceBadge(undefined)).toBe('');
  });

  it('returns confident for >= 0.8', () => {
    expect(confidenceBadge({ ...ENV, confidence: 1.0 })).toBe('⭐ confident');
    expect(confidenceBadge({ ...ENV, confidence: 0.8 })).toBe('⭐ confident');
  });

  it('returns likely for 0.5..0.8', () => {
    expect(confidenceBadge({ ...ENV, confidence: 0.6 })).toBe('· likely');
  });

  it('returns uncertain for < 0.5', () => {
    expect(confidenceBadge({ ...ENV, confidence: 0.2 })).toBe('🤔 uncertain');
  });

  it('treats missing confidence number as confident (Stage 1 default)', () => {
    expect(confidenceBadge({ ...ENV, confidence: undefined as unknown as number })).toBe(
      '⭐ confident'
    );
  });
});

describe('MemoryClient envelope passthrough', () => {
  it('surfaces envelope alongside results when desktop app sends it', async () => {
    FakeWebSocket.instances = [];
    FakeWebSocket.nextResponse = {
      op: 'search.result',
      results: [
        { file: '/m/x.md', title: 't', snippet: 's', preview: 'p' },
      ],
      tookMs: 7,
      envelope: { ...ENV },
    } as ServerResponse;
    const c = new MemoryClient({
      endpoint: 'ws://x',
      webSocketCtor: FakeWebSocket as unknown as typeof WebSocket,
      timeoutMs: 200,
    });
    const out = await c.search('hello');
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.envelope).toBeDefined();
      expect(out.envelope?.confidence).toBe(1.0);
      expect(out.envelope?.source_atoms).toEqual(['evt-2026-04-25-aaaaaaaaaa']);
    }
  });

  it('still works when desktop app omits the envelope (older versions)', async () => {
    FakeWebSocket.instances = [];
    FakeWebSocket.nextResponse = {
      op: 'search.result',
      results: [],
    } as ServerResponse;
    const c = new MemoryClient({
      endpoint: 'ws://x',
      webSocketCtor: FakeWebSocket as unknown as typeof WebSocket,
      timeoutMs: 200,
    });
    const out = await c.search('hello');
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.envelope).toBeUndefined();
    }
  });
});
