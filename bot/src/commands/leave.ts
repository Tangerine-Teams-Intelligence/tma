// /tmi-leave handler. Stops capture; spawns sidecar `tmi wrap --auto` if auto_wrap=true.

import { spawn } from "node:child_process";
import {
  type ChatInputCommandInteraction,
  MessageFlags,
} from "discord.js";
import type { VoiceCapture } from "../voice.js";
import type { MeetingContext } from "../meeting.js";

export async function handleLeave(
  interaction: ChatInputCommandInteraction,
  capture: VoiceCapture,
  meeting: MeetingContext,
  log: (msg: string) => void,
): Promise<void> {
  const autoWrap = interaction.options.getBoolean("auto_wrap") ?? true;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    await capture.leave();
  } catch (err) {
    log(`leave error: ${(err as Error).message}`);
  }
  if (autoWrap) {
    try {
      const child = spawn("tmi", ["wrap", "--auto", meeting.meeting.id], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      log(`spawned tmi wrap --auto for ${meeting.meeting.id}`);
    } catch (err) {
      log(`failed to spawn tmi wrap: ${(err as Error).message}`);
    }
  }
  await interaction.editReply({
    content: autoWrap
      ? "Left voice. Wrap running in background."
      : "Left voice. Run `tmi wrap` when ready.",
  });
  // Bot exits via SIGTERM from CLI; do not exit here.
}
