import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { activeLocale, setLocale } from "@/i18n";
import type { ConfigDraft } from "./Settings";

interface Props {
  draft: ConfigDraft;
  update: <K extends keyof ConfigDraft>(key: K, val: ConfigDraft[K]) => void;
}

export function GeneralSettings({ draft, update }: Props) {
  const { t } = useTranslation();
  const [lang, setLang] = useState<"en" | "zh">(activeLocale());

  return (
    <div className="flex max-w-xl flex-col gap-4">
      <div>
        <Label htmlFor="st-meetings-repo">Meetings repo</Label>
        <Input
          id="st-meetings-repo"
          value={draft.meetings_repo}
          onChange={(e) => update("meetings_repo", e.target.value)}
          placeholder="C:\\Users\\you\\tangerine-meetings"
          data-testid="st-meetings-repo"
        />
        <p className="mt-1 text-xs text-[var(--ti-ink-500)]">
          Git repo where meetings/ subdirs live.
        </p>
      </div>

      <div>
        <Label htmlFor="st-log-level">Log level</Label>
        <select
          id="st-log-level"
          value={draft.log_level}
          onChange={(e) => update("log_level", e.target.value)}
          data-testid="st-log-level"
          className="mt-1 h-10 w-full rounded-md border border-[var(--ti-border-default)] bg-[var(--ti-paper-50)] px-3 text-sm"
        >
          <option value="debug">debug</option>
          <option value="info">info</option>
          <option value="warning">warning</option>
          <option value="error">error</option>
        </select>
      </div>

      {/* Wave 3 — Language toggle (OBSERVABILITY_SPEC §6) */}
      <div>
        <Label htmlFor="st-language">{t("settings.language.label")}</Label>
        <select
          id="st-language"
          value={lang}
          onChange={async (e) => {
            const next = e.target.value === "zh" ? "zh" : "en";
            setLang(next);
            await setLocale(next);
          }}
          data-testid="st-language"
          aria-label={t("settings.language.label")}
          className="mt-1 h-10 w-full rounded-md border border-[var(--ti-border-default)] bg-[var(--ti-paper-50)] px-3 text-sm"
        >
          <option value="en">{t("settings.language.english")}</option>
          <option value="zh">{t("settings.language.chinese")}</option>
        </select>
        <p className="mt-1 text-xs text-[var(--ti-ink-500)]">
          {t("settings.language.subtitle")}
        </p>
      </div>

      <div>
        <Label htmlFor="st-tz">Default timezone</Label>
        <Input id="st-tz" value="Asia/Shanghai" disabled />
        <p className="mt-1 text-xs text-[var(--ti-ink-500)]">
          Locked to Asia/Shanghai per project default. T6 will surface a picker if anyone asks.
        </p>
      </div>
    </div>
  );
}
