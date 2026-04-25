import { useState } from "react";
import { Plus, X, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { WizardShell } from "./WizardShell";
import { useStore, type TeamMember } from "@/lib/store";

const ALIAS_RE = /^[a-z][a-z0-9_]*$/;
const DISCORD_ID_RE = /^\d{17,20}$/;

function emptyRow(): TeamMember {
  return { alias: "", displayName: "", discordId: "" };
}

export function SW4TeamMembers() {
  const back = useStore((s) => s.wizard.back);
  const next = useStore((s) => s.wizard.next);
  const setField = useStore((s) => s.wizard.setField);
  const collected = useStore((s) => s.wizard.collected);

  const [rows, setRows] = useState<TeamMember[]>(
    collected.team && collected.team.length > 0 ? collected.team : [emptyRow()]
  );

  function update(idx: number, patch: Partial<TeamMember>) {
    setRows((r) => r.map((row, i) => (i === idx ? { ...row, ...patch } : row)));
  }

  function add() {
    setRows((r) => [...r, emptyRow()]);
  }

  function remove(idx: number) {
    setRows((r) => (r.length === 1 ? r : r.filter((_, i) => i !== idx)));
  }

  const errors = validateAll(rows);
  const canContinue = errors.length === 0;

  function handleNext() {
    setField("team", rows);
    next();
  }

  return (
    <WizardShell
      title="Your team"
      subtitle="Add the people who will join meetings. Each needs a Discord ID we can label transcripts with."
      stepLabel="Step 4 of 5 — Team"
      footer={
        <>
          <Button variant="outline" onClick={back}>
            ← Back
          </Button>
          <Button onClick={handleNext} disabled={!canContinue}>
            Next: Review →
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-[1fr_1fr_1fr_auto] gap-3 text-xs text-[var(--ti-ink-500)]">
          <Label>Alias</Label>
          <Label>Display name</Label>
          <Label>Discord ID (optional)</Label>
          <span />
        </div>

        {rows.map((r, idx) => {
          const aliasBad = r.alias.length > 0 && !ALIAS_RE.test(r.alias);
          const idBad = r.discordId.length > 0 && !DISCORD_ID_RE.test(r.discordId);
          return (
            <div key={idx} className="grid grid-cols-[1fr_1fr_1fr_auto] items-start gap-3">
              <Input
                placeholder="daizhe"
                value={r.alias}
                onChange={(e) => update(idx, { alias: e.target.value })}
                invalid={aliasBad}
              />
              <Input
                placeholder="Daizhe Zou"
                value={r.displayName}
                onChange={(e) => update(idx, { displayName: e.target.value })}
              />
              <Input
                placeholder="123456789012345678"
                value={r.discordId}
                onChange={(e) => update(idx, { discordId: e.target.value })}
                invalid={idBad}
              />
              <Button
                variant="ghost"
                size="icon"
                onClick={() => remove(idx)}
                disabled={rows.length === 1}
                aria-label="Remove row"
              >
                <X size={16} />
              </Button>
            </div>
          );
        })}

        <Button variant="outline" onClick={add} size="sm">
          <Plus size={14} /> Add member
        </Button>

        {errors.length > 0 && (
          <ul className="space-y-1">
            {errors.map((e, i) => (
              <li key={i} className="flex items-center gap-1 text-xs text-[#B83232]">
                <AlertCircle size={12} /> {e}
              </li>
            ))}
          </ul>
        )}

        <p className="text-xs italic text-[var(--ti-ink-500)]">
          To copy a Discord ID: enable Developer Mode (Settings → Advanced), then right-click a user
          → Copy User ID.
        </p>
      </div>
    </WizardShell>
  );
}

function validateAll(rows: TeamMember[]): string[] {
  const errs: string[] = [];
  if (rows.length === 0) errs.push("At least one team member required.");
  const seen = new Set<string>();
  for (const r of rows) {
    if (!r.alias.trim()) {
      errs.push("Every row needs an alias.");
      break;
    }
    if (!ALIAS_RE.test(r.alias)) {
      errs.push(`Alias "${r.alias}" must match ^[a-z][a-z0-9_]*$.`);
    }
    if (seen.has(r.alias)) errs.push(`Duplicate alias: ${r.alias}.`);
    seen.add(r.alias);
    if (!r.displayName.trim()) {
      errs.push(`"${r.alias}" needs a display name.`);
    }
    if (r.discordId && !DISCORD_ID_RE.test(r.discordId)) {
      errs.push(`Discord ID "${r.discordId}" should be 17–20 digits.`);
    }
  }
  return errs;
}
