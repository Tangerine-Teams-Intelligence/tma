// Atom schema (sources/README.md) + Calendar-specific helpers.
//
// Calendar atoms cover two situations of the same event:
//   - past calendar event (already happened)             → kind: calendar_event
//   - upcoming calendar event (used by daemon for brief) → kind: calendar_event
//
// The brief-trigger lives in `briefs.ts` and consumes the upcoming-events
// list, not the persisted atoms. Atoms are still emitted for upcoming events
// so the timeline tells you what's coming, but the daemon's pre-meeting brief
// hook reads `listUpcoming()` directly.

export type AtomKind = "calendar_event";

export interface AtomCalendarRef {
  /** Source identifier — e.g. "ical" or "google". */
  provider: "ical" | "google";
  /** Calendar id / feed slug we ingested from. */
  calendar: string;
  /** Calendar event UID (RFC 5545 `UID:` line for iCal). Stable across edits. */
  uid: string;
  /** Generated event slug — used as a meeting hint when titles match. */
  slug: string;
  /** Start time, RFC 3339. */
  start: string;
  /** End time, RFC 3339 (may equal start for all-day events). */
  end: string;
  /** Event title. */
  title: string;
  /** Original location string, if present. */
  location?: string;
  /** Organizer email, if present. */
  organizer?: string;
  /** Direct URL (e.g. Google Calendar event link). */
  url?: string;
}

export interface AtomRefs {
  calendar?: AtomCalendarRef;
  meeting: string | null;
  decisions: string[];
  people: string[];
  projects: string[];
  threads: string[];
  /** Set when daemon detects this event matches a captured meeting record. */
  meetings?: string[];
}

/**
 * The 8 Stage-1 AGI hook fields (STAGE1_AGI_HOOKS.md, Hook 1). Every atom
 * carries them — Stage 1 fills the documented defaults, Stage 2 reasoning
 * loops mutate them.
 */
export interface AgiHooks {
  embedding: number[] | null;        // Stage 2: vector[1536]
  concepts: string[];                // Stage 2: NER + concept resolution
  confidence: number;                // Stage 1: 1.0 (raw)
  alternatives: string[];            // Stage 2: ambiguous interpretations
  source_count: number;              // Stage 1: 1
  reasoning_notes: string | null;    // Stage 2: reasoning loop annotations
  sentiment: string | null;          // Stage 2: tone analysis
  importance: number | null;         // Stage 2: 0-1 priority
}

export interface Atom {
  id: string;
  ts: string; // RFC 3339 UTC
  source: "calendar";
  actor: string;
  actors: string[];
  kind: AtomKind;
  refs: AtomRefs;
  status: "active" | "superseded" | "archived";
  sample: boolean;
  body: string;
  agi: AgiHooks;
}

/** A single configured calendar feed. */
export interface CalendarConfig {
  /** Stable id; for iCal we hash the URL, for google we use the calendar id. */
  id: string;
  /** Provider type. */
  provider: "ical" | "google";
  /** Display name. */
  name?: string;
  /** iCal feed URL (only set when provider=ical). */
  url?: string;
  /** Google calendar id (only set when provider=google). */
  google_calendar_id?: string;
  /** Optional project tag(s) attached to every atom from this calendar. */
  projects?: string[];
  /** Most-recent event UID we've ingested. Used for cursor-style dedup but
   *  the primary dedup key is still the atom id. */
  cursor?: string;
}

export interface SourceConfig {
  schema_version: 1;
  poll_interval_sec: number;
  calendars: CalendarConfig[];
  /** How many minutes before an event we should generate a pre-meeting brief.
   *  Default 5 (CEO direction in the spec). */
  brief_lead_minutes: number;
  /** Window for "upcoming" events the daemon checks each tick. Default 10. */
  upcoming_window_minutes: number;
}

export type IdentityMap = Record<string, string>;

/** Default config for a fresh install. */
export function defaultConfig(): SourceConfig {
  return {
    schema_version: 1,
    poll_interval_sec: 60,
    calendars: [],
    brief_lead_minutes: 5,
    upcoming_window_minutes: 10,
  };
}

/** Defaults for every atom's AGI hook block. STAGE1_AGI_HOOKS.md Hook 1. */
export function defaultAgi(): AgiHooks {
  return {
    embedding: null,
    concepts: [],
    confidence: 1.0,
    alternatives: [],
    source_count: 1,
    reasoning_notes: null,
    sentiment: null,
    importance: null,
  };
}
