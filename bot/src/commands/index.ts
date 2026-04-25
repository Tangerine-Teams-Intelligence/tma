// Slash command registration. Scoped to guild_id if config has one, else global.
// Spec: INTERFACES.md §5.2.

import {
  REST,
  Routes,
  SlashCommandBuilder,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord.js";

export function buildCommands(
  prefix: string,
): RESTPostAPIChatInputApplicationCommandsJSONBody[] {
  const join = new SlashCommandBuilder()
    .setName(`${prefix}-join`)
    .setDescription("Join your voice channel and start capturing audio.");

  const leave = new SlashCommandBuilder()
    .setName(`${prefix}-leave`)
    .setDescription("Leave the voice channel and stop capturing.")
    .addBooleanOption((opt) =>
      opt
        .setName("auto_wrap")
        .setDescription("Trigger tmi wrap after leaving (default: true).")
        .setRequired(false),
    );

  const status = new SlashCommandBuilder()
    .setName(`${prefix}-status`)
    .setDescription("Show meeting state and transcript line count.");

  return [join.toJSON(), leave.toJSON(), status.toJSON()];
}

export async function registerCommands(args: {
  token: string;
  appId: string;
  guildId: string | null;
  prefix: string;
  log: (msg: string) => void;
}): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(args.token);
  const body = buildCommands(args.prefix);
  if (args.guildId) {
    await rest.put(Routes.applicationGuildCommands(args.appId, args.guildId), { body });
    args.log(`registered ${body.length} commands to guild ${args.guildId}`);
  } else {
    await rest.put(Routes.applicationCommands(args.appId), { body });
    args.log(`registered ${body.length} commands globally`);
  }
}
