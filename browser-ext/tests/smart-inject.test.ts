/**
 * smart-inject.test.ts — heuristic + memo + debouncer + chip-show predicate.
 *
 * Pure-logic tests, no DOM. The chip rendering is exercised by the smart-chip
 * test in this same suite (separate file).
 */

import { describe, expect, it, vi } from 'vitest';
import {
  DEBOUNCE_MS,
  MIN_QUERY_LEN,
  SmartInjectMemo,
  isQuestionLike,
  makeDebouncer,
  shouldShowChip,
} from '../src/shared/smart-inject';

describe('isQuestionLike', () => {
  it('rejects short text', () => {
    expect(isQuestionLike('hi')).toBe(false);
    expect(isQuestionLike('a'.repeat(MIN_QUERY_LEN - 1))).toBe(false);
  });

  it('accepts text ending in ?', () => {
    expect(isQuestionLike('what about pricing?')).toBe(true);
    expect(isQuestionLike('1234567890?')).toBe(true);
  });

  it('accepts wh-words', () => {
    expect(isQuestionLike('what did david say about pricing')).toBe(true);
    expect(isQuestionLike('how should I approach this case')).toBe(true);
    expect(isQuestionLike('who owns the postgres migration')).toBe(true);
    expect(isQuestionLike('when did we ship v15')).toBe(true);
    expect(isQuestionLike('where is the design doc')).toBe(true);
    expect(isQuestionLike('why did we pick whisper over deepgram')).toBe(true);
    expect(isQuestionLike('which approach won the arch debate')).toBe(true);
  });

  it('accepts long prompts (>50 chars) even without wh-words', () => {
    const long = 'I want a complete summary of the postgres migration drama.';
    expect(isQuestionLike(long)).toBe(true);
  });

  it('accepts imperative verbs that imply context lookup', () => {
    expect(isQuestionLike('explain the v1 launch')).toBe(true);
    expect(isQuestionLike('summarise the david sync')).toBe(true);
    expect(isQuestionLike('summarize the david sync')).toBe(true);
    expect(isQuestionLike('remind me about pricing')).toBe(true);
    expect(isQuestionLike('find the postgres doc')).toBe(true);
    expect(isQuestionLike('look up that decision')).toBe(true);
    expect(isQuestionLike('look  up the decision')).toBe(true);
    expect(isQuestionLike('recap last week')).toBe(true);
    expect(isQuestionLike('catch me up on eric')).toBe(true);
    expect(isQuestionLike('tell me about pricing')).toBe(true);
  });

  it('rejects shopping-list / non-question text', () => {
    expect(isQuestionLike('eggs milk bread')).toBe(false);
    expect(isQuestionLike('foo bar baz')).toBe(false);
  });

  it('handles empty / null input', () => {
    expect(isQuestionLike('')).toBe(false);
    expect(isQuestionLike('   ')).toBe(false);
    expect(isQuestionLike(null as unknown as string)).toBe(false);
  });

  it('does NOT trigger on wh-substring inside another word', () => {
    expect(isQuestionLike('howdy hi yo')).toBe(false);
    expect(isQuestionLike('whatever blah')).toBe(false);
  });
});

describe('SmartInjectMemo', () => {
  it('records dismissals and reports them', () => {
    const m = new SmartInjectMemo();
    expect(m.isDismissed('hello world')).toBe(false);
    m.dismiss('hello world');
    expect(m.isDismissed('hello world')).toBe(true);
  });

  it('treats whitespace + case differences as identical', () => {
    const m = new SmartInjectMemo();
    m.dismiss('  Hello WORLD  ');
    expect(m.isDismissed('hello world')).toBe(true);
  });

  it('clears state on demand', () => {
    const m = new SmartInjectMemo();
    m.dismiss('a');
    m.dismiss('b');
    expect(m.size()).toBe(2);
    m.clear();
    expect(m.size()).toBe(0);
    expect(m.isDismissed('a')).toBe(false);
  });

  it('hash is deterministic', () => {
    const m = new SmartInjectMemo();
    expect(m.hash('Foo BAR')).toBe(m.hash('foo bar'));
  });
});

describe('makeDebouncer', () => {
  it('fires once after the trailing call', async () => {
    vi.useFakeTimers();
    let count = 0;
    let last = '';
    const d = makeDebouncer<string>(50, (a) => {
      count++;
      last = a;
    });
    d('a');
    d('b');
    d('c');
    expect(count).toBe(0);
    await vi.advanceTimersByTimeAsync(60);
    expect(count).toBe(1);
    expect(last).toBe('c');
    vi.useRealTimers();
  });

  it('subsequent calls reset the timer', async () => {
    vi.useFakeTimers();
    let count = 0;
    const d = makeDebouncer<number>(50, () => {
      count++;
    });
    d(1);
    await vi.advanceTimersByTimeAsync(30);
    d(2);
    await vi.advanceTimersByTimeAsync(30);
    expect(count).toBe(0);
    await vi.advanceTimersByTimeAsync(30);
    expect(count).toBe(1);
    vi.useRealTimers();
  });

  it('uses the spec-default DEBOUNCE_MS=1500', () => {
    expect(DEBOUNCE_MS).toBe(1500);
  });
});

describe('shouldShowChip', () => {
  it('hides when no results', () => {
    expect(shouldShowChip([])).toBe(false);
  });

  it('shows when results have no score (Stage 1 default-confident)', () => {
    expect(shouldShowChip([{}])).toBe(true);
    expect(shouldShowChip([{ score: 0.9 }])).toBe(true);
  });

  it('handles non-array gracefully', () => {
    expect(shouldShowChip(undefined as unknown as Array<{ score?: number }>)).toBe(
      false
    );
  });
});
