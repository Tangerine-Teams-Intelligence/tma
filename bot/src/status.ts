// status.yaml writer. Bot owns ONLY the bot.* subtree per §5.4.
// Atomic rename, never holds the file open across awaits.

import {
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { dirname } from "node:path";
import yaml from "js-yaml";

export interface BotStatusSubtree {
  pid: number | null;
  started_at: string | null;
  voice_channel_id: string | null;
  reconnect_count: number;
  listening_since?: string | null;
  lines_written?: number;
  connected?: boolean;
  errors?: BotError[];
}

export interface BotError {
  at: string;
  component: "bot";
  code: string;
  detail: string;
}

export interface StatusError {
  at: string;
  component: string;
  code: string;
  detail: string;
}

interface StatusFile {
  schema_version?: number;
  state?: string;
  bot?: BotStatusSubtree;
  errors?: StatusError[];
  [key: string]: unknown;
}

/**
 * Read current status.yaml (or fabricate empty), merge bot subtree, atomic-rename write.
 * NEVER mutates non-bot keys.
 */
export class StatusWriter {
  private readonly path: string;
  private chain: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.path = path;
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  async updateBot(patch: Partial<BotStatusSubtree>): Promise<void> {
    const task = async (): Promise<void> => {
      const current = this.read();
      current.bot = { ...(current.bot ?? this.defaultBot()), ...patch };
      this.atomicWrite(current);
    };
    const next = this.chain.then(task, task);
    this.chain = next.catch(() => undefined);
    await next;
  }

  /** Append a top-level error AND a bot.errors entry. */
  async pushError(code: string, detail: string): Promise<void> {
    const task = async (): Promise<void> => {
      const current = this.read();
      const at = new Date().toISOString();
      const err: StatusError = { at, component: "bot", code, detail };
      current.errors = [...(current.errors ?? []), err];
      const bot = current.bot ?? this.defaultBot();
      bot.errors = [...(bot.errors ?? []), { at, component: "bot", code, detail }];
      current.bot = bot;
      this.atomicWrite(current);
    };
    const next = this.chain.then(task, task);
    this.chain = next.catch(() => undefined);
    await next;
  }

  private read(): StatusFile {
    if (!existsSync(this.path)) {
      return { schema_version: 1, bot: this.defaultBot() };
    }
    try {
      const raw = readFileSync(this.path, "utf8");
      const parsed = yaml.load(raw) as StatusFile | null;
      return parsed ?? { schema_version: 1, bot: this.defaultBot() };
    } catch {
      return { schema_version: 1, bot: this.defaultBot() };
    }
  }

  private atomicWrite(data: StatusFile): void {
    const tmp = `${this.path}.tmp`;
    const dump = yaml.dump(data, { indent: 2, lineWidth: 120, noRefs: true });
    writeFileSync(tmp, dump, "utf8");
    renameSync(tmp, this.path);
  }

  private defaultBot(): BotStatusSubtree {
    return {
      pid: null,
      started_at: null,
      voice_channel_id: null,
      reconnect_count: 0,
      connected: false,
      listening_since: null,
      lines_written: 0,
      errors: [],
    };
  }
}
