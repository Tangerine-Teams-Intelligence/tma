// Public entry. Re-exports the high-level API for embedders (the desktop app
// will spawn the CLI as a subprocess, but anyone consuming the package
// programmatically gets the same surface — the daemon imports `pollBriefTriggers`
// from here for the pre-meeting brief loop.)

export { runOnce, runForever, type PollOpts, type PollResult, type CalendarPollResult } from "./poll.js";
export {
  setKeytarForTesting,
  setGoogleToken,
  getGoogleToken,
  deleteGoogleToken,
  hasGoogleToken,
  KEYTAR_SERVICE,
  OAUTH_CLIENT_ID,
} from "./auth.js";
export {
  defaultMemoryRoot,
  makePaths,
  readConfig,
  writeConfig,
  readCursors,
  writeCursors,
  readIdentity,
  writeIdentity,
  writeAtom,
  writeAtoms,
  atomToMarkdown,
  type MemoryPaths,
  type CursorMap,
} from "./memory.js";
export { fetchIcal } from "./client.js";
export {
  parseIcal,
  pastEvents,
  upcomingEvents,
  type ParsedEvent,
  type ParseOpts,
} from "./parser.js";
export {
  makeCtx,
  normalizeEvent,
  eventSlug,
  slugify,
  aliasFor,
  type NormalizeCtx,
} from "./normalize.js";
export {
  ingestFeed,
  ingestParsed,
  type IngestFeedResult,
  type IngestFeedOpts,
} from "./ingest/feed.js";
export {
  nextBriefTriggers,
  briefForEvent,
  pollBriefTriggers,
  type BriefTrigger,
} from "./briefs.js";
export type {
  Atom,
  AtomKind,
  AtomRefs,
  AtomCalendarRef,
  AgiHooks,
  CalendarConfig,
  SourceConfig,
  IdentityMap,
} from "./types.js";
export { defaultConfig, defaultAgi } from "./types.js";
