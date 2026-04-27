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

export function AdaptersSettings({ draft, update }: Props) {
  const { t } = useTranslation();
  const setRow = (i: number, patch: Partial<ConfigDraft["output_adapters"][number]>) => {
    update(
      "output_adapters",
      draft.output_adapters.map((a, idx) => (idx === i ? { ...a, ...patch } : a))
    );
  };
  const remove = (i: number) =>
    update(
      "output_adapters",
      draft.output_adapters.filter((_, idx) => idx !== i)
    );
  const add = () =>
    update("output_adapters", [
      ...draft.output_adapters,
      { name: "", target_repo: "" },
    ]);

  return (
    <div className="flex flex-col gap-6">
      <section>
        <h3 className="font-display text-lg">{t("settings.adapters.title")}</h3>
        <p className="text-xs text-[var(--ti-ink-500)]">
          {t("settings.adapters.subtitle")}
        </p>
        <div className="mt-3 flex flex-col gap-3">
          {draft.output_adapters.map((a, i) => (
            <div
              key={i}
              className="grid grid-cols-[1fr_2fr_auto] gap-2"
              data-testid={`adapter-row-${i}`}
            >
              <Input
                value={a.name}
                onChange={(e) => setRow(i, { name: e.target.value })}
                placeholder="default"
              />
              <Input
                value={a.target_repo}
                onChange={(e) => setRow(i, { target_repo: e.target.value })}
                placeholder="C:\\path\\to\\target-repo"
              />
              <Button
                variant="ghost"
                size="icon"
                onClick={() => remove(i)}
                aria-label={t("settings.adapters.removeAdapter")}
                data-testid={`adapter-remove-${i}`}
              >
                <Trash2 size={16} />
              </Button>
            </div>
          ))}
          <Button variant="outline" size="sm" onClick={add} className="self-start">
            <Plus size={14} />
            {t("settings.adapters.addAdapter")}
          </Button>
        </div>
      </section>

      <section>
        <h3 className="font-display text-lg">{t("settings.adapters.whisperTitle")}</h3>
        <div className="mt-3 grid max-w-xl grid-cols-2 gap-3">
          <div>
            <Label htmlFor="adp-model">{t("settings.adapters.model")}</Label>
            <Input
              id="adp-model"
              value={draft.whisper_model}
              onChange={(e) => update("whisper_model", e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="adp-chunk">{t("settings.adapters.chunkSeconds")}</Label>
            <Input
              id="adp-chunk"
              type="number"
              min={5}
              max={30}
              value={draft.whisper_chunk_seconds}
              onChange={(e) =>
                update("whisper_chunk_seconds", Number(e.target.value || 10))
              }
              data-testid="adp-chunk-seconds"
            />
          </div>
        </div>
      </section>
    </div>
  );
}
// === end wave 5-α ===
