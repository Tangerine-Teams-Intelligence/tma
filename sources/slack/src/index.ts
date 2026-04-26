// Public entry. Re-exports the high-level API for embedders (the desktop app
// will spawn the CLI as a subprocess, but anyone consuming the package
// programmatically gets the same surface.)

export { runOnce, runForever, type PollOpts, type PollResult, type ChannelPollResult } from "./poll.js";
export {
  setToken,
  getToken,
  deleteToken,
  hasToken,
  validateToken,
  setKeytarForTesting,
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
export { makeClient, rateLimitBackoffMs, type SlackClient } from "./client.js";
export {
  makeCtx,
  type NormalizeCtx,
  normalizeMessage,
  normalizeChannelCreated,
  normalizePin,
  extractMentions,
  aliasFor,
  looksLikeDecision,
  projectsForChannel,
  slackTsToIso,
  type RawMessage,
  type RawChannelCreated,
  type RawPin,
} from "./normalize.js";
export { ingestMessages, type IngestMessagesResult } from "./ingest/messages.js";
export { ingestNewChannels, listRemoteChannels, type IngestChannelsResult } from "./ingest/channels.js";
export type {
  Atom,
  AtomKind,
  AtomRefs,
  AtomSlackRef,
  AgiHooks,
  ChannelConfig,
  SourceConfig,
  IdentityMap,
  AuthMode,
} from "./types.js";
export { defaultConfig, defaultAgi } from "./types.js";
