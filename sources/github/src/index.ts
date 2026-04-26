// Public entry. Re-exports the high-level API for embedders (the desktop app
// will spawn the CLI as a subprocess, but anyone consuming the package
// programmatically gets the same surface.)

export { runOnce, runForever, type PollOpts, type PollResult } from "./poll.js";
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
  readIdentity,
  writeIdentity,
  writeAtom,
  writeAtoms,
  atomToMarkdown,
  type MemoryPaths,
} from "./memory.js";
export { makeClient, type GhClient } from "./client.js";
export { makeCtx, type NormalizeCtx } from "./normalize.js";
export { processWebhook } from "./ingest/webhook.js";
export type { Atom, AtomKind, AtomRefs, RepoConfig, SourceConfig, IdentityMap } from "./types.js";
