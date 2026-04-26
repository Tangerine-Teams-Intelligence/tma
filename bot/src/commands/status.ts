// /tmi-status handler. Reads current status.yaml + transcript line count.

import { readFileSync, existsSync } from "node:fs";
import {
  type ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
} from "discord.js";
import yaml from "js-yaml";
import type { MeetingContext } from "../meeting.js";

export async function handleStatus(
  interaction: ChatInputCommandInteraction,
  meeting: MeetingContext,
): Promise<void> {
  let state = "unknown";
  try {
    if (existsSync(meeting.statusPath)) {
      const data = yaml.load(readFileSync(meeting.statusPath, "utf8")) as {
        state?: string;
      };
      state = data?.state ?? "unknown";
    }
  } catch {
    state = "unreadable";
  }
  let lineCount = 0;
  try {
    if (existsSync(meeting.transcriptPath)) {
      const text = readFileSync(meeting.transcriptPath, "utf8");
      lineCount = text.length === 0 ? 0 : text.split("\n").filter(Boolean).length;
    }
  } catch {
    /* ignore */
  }
  const embed = new EmbedBuilder()
    .setTitle(`TMA · ${meeting.meeting.id}`)
    .addFields(
      { name: "State", value: state, inline: true },
      {
        name: "Participants",
        value: meeting.participantAliases().join(", ") || "(none)",
        inline: true,
      },
      { name: "Transcript lines", value: String(lineCount), inline: true },
    )
    .setFooter({ text: "Tangerine Meeting Assistant v1" });
  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}
