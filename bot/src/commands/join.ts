// /tmi-join handler.

import {
  type ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
} from "discord.js";
import type { VoiceCapture } from "../voice.js";
import type { MeetingContext } from "../meeting.js";

export async function handleJoin(
  interaction: ChatInputCommandInteraction,
  capture: VoiceCapture,
  meeting: MeetingContext,
): Promise<void> {
  const member = interaction.member;
  const channel =
    member && "voice" in member ? member.voice.channel : null;
  if (!channel) {
    await interaction.reply({
      content: "Join a voice channel first, then run this again.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (capture.isConnected()) {
    await interaction.reply({
      content: "Already connected. Run /tmi-leave first to switch channels.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    await capture.join(channel);
    const embed = new EmbedBuilder()
      .setTitle(`TMA · ${meeting.meeting.id}`)
      .addFields(
        { name: "State", value: "live", inline: true },
        { name: "Channel", value: channel.name, inline: true },
        {
          name: "Participants",
          value: meeting.participantAliases().join(", ") || "(none)",
          inline: true,
        },
      )
      .setFooter({ text: "Tangerine Meeting Assistant v1" });
    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    await interaction.editReply({
      content: `Join failed: ${(err as Error).message}`,
    });
  }
}
