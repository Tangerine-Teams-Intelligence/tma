import { useStore } from "@/lib/store";
import { SW0Welcome } from "@/components/wizard/SW0Welcome";
import { SW1DiscordBot } from "@/components/wizard/SW1DiscordBot";
import { SW2LocalWhisper } from "@/components/wizard/SW2LocalWhisper";
import { SW3ClaudeDetect } from "@/components/wizard/SW3ClaudeDetect";
import { SW4TeamMembers } from "@/components/wizard/SW4TeamMembers";
import { SW5Complete } from "@/components/wizard/SW5Complete";

export default function SetupRoute() {
  const step = useStore((s) => s.wizard.step);

  switch (step) {
    case 0:
      return <SW0Welcome />;
    case 1:
      return <SW1DiscordBot />;
    case 2:
      return <SW2LocalWhisper />;
    case 3:
      return <SW3ClaudeDetect />;
    case 4:
      return <SW4TeamMembers />;
    case 5:
      return <SW5Complete />;
    default:
      return <SW0Welcome />;
  }
}
