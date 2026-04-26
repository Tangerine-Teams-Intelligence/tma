// Meeting directory ops: read meeting.yaml, resolve aliases, manage GUEST counter.
// Spec: INTERFACES.md §2.0, §2.1.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";

export interface Participant {
  alias: string;
  display_name: string;
  discord_id?: string | null;
}

export interface Meeting {
  schema_version: number;
  id: string;
  title: string;
  created_at: string;
  scheduled_at?: string;
  participants: Participant[];
  target_adapter: string;
  tags?: string[];
}

export class MeetingContext {
  readonly meetingDir: string;
  readonly meeting: Meeting;
  private readonly discordToAlias: Map<string, string>;
  private guestCounter = 0;
  private readonly assignedGuests: Map<string, string> = new Map();

  constructor(meetingDir: string) {
    this.meetingDir = meetingDir;
    const yamlPath = join(meetingDir, "meeting.yaml");
    if (!existsSync(yamlPath)) {
      throw new Error(`meeting.yaml not found at ${yamlPath}`);
    }
    const raw = readFileSync(yamlPath, "utf8");
    this.meeting = yaml.load(raw) as Meeting;
    if (this.meeting?.schema_version !== 1) {
      throw new Error(
        `meeting.yaml schema_version must be 1, got ${String(this.meeting?.schema_version)}`,
      );
    }
    this.discordToAlias = new Map();
    for (const p of this.meeting.participants ?? []) {
      if (p.discord_id) {
        this.discordToAlias.set(p.discord_id, p.alias);
      }
    }
  }

  /** Resolve a Discord user ID to either a known alias or an assigned `GUEST:N`. */
  resolveAlias(discordId: string): string {
    const known = this.discordToAlias.get(discordId);
    if (known) return known;
    const cached = this.assignedGuests.get(discordId);
    if (cached) return cached;
    this.guestCounter += 1;
    const tag = `GUEST:${this.guestCounter}`;
    this.assignedGuests.set(discordId, tag);
    return tag;
  }

  get transcriptPath(): string {
    return join(this.meetingDir, "transcript.md");
  }

  get statusPath(): string {
    return join(this.meetingDir, "status.yaml");
  }

  get botLogPath(): string {
    return join(this.meetingDir, ".tmi", "bot.log");
  }

  participantAliases(): string[] {
    return (this.meeting.participants ?? []).map((p) => p.alias);
  }
}
