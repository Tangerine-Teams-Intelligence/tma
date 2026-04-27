// === wave 5-α ===
import { useTranslation } from "react-i18next";
import { Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ConfigDraft } from "./Settings";

interface Props {
  draft: ConfigDraft;
  update: <K extends keyof ConfigDraft>(key: K, val: ConfigDraft[K]) => void;
}

export function TeamSettings({ draft, update }: Props) {
  const { t } = useTranslation();
  const setRow = (i: number, patch: Partial<ConfigDraft["team"][number]>) => {
    const next = draft.team.map((m, idx) => (idx === i ? { ...m, ...patch } : m));
    update("team", next);
  };
  const removeRow = (i: number) => {
    update(
      "team",
      draft.team.filter((_, idx) => idx !== i)
    );
  };
  const addRow = () => {
    update("team", [
      ...draft.team,
      { alias: "", display_name: "", discord_id: "" },
    ]);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-[1fr_1fr_1fr_auto] gap-2 text-xs text-[var(--ti-ink-500)]">
        <Label>{t("settings.team.alias")}</Label>
        <Label>{t("settings.team.displayName")}</Label>
        <Label>{t("settings.team.discordId")}</Label>
        <span />
      </div>
      {draft.team.map((m, i) => (
        <div
          key={i}
          className="grid grid-cols-[1fr_1fr_1fr_auto] gap-2"
          data-testid={`team-row-${i}`}
        >
          <Input
            value={m.alias}
            onChange={(e) => setRow(i, { alias: e.target.value })}
            placeholder="daizhe"
          />
          <Input
            value={m.display_name}
            onChange={(e) => setRow(i, { display_name: e.target.value })}
            placeholder="Daizhe"
          />
          <Input
            value={m.discord_id}
            onChange={(e) => setRow(i, { discord_id: e.target.value })}
            placeholder="1234567890..."
          />
          <Button
            variant="ghost"
            size="icon"
            onClick={() => removeRow(i)}
            aria-label={t("settings.team.removeRow")}
            data-testid={`team-remove-${i}`}
          >
            <Trash2 size={16} />
          </Button>
        </div>
      ))}
      <Button variant="outline" size="sm" onClick={addRow} className="self-start" data-testid="team-add">
        <Plus size={14} />
        {t("settings.team.addRow")}
      </Button>
    </div>
  );
}
// === end wave 5-α ===
