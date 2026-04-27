import { useState } from "react";
import { Star, Download, Tag, GitBranch, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useStore } from "@/lib/store";
import {
  marketplaceInstallTemplate,
  marketplaceUninstallTemplate,
  type Template,
} from "@/lib/tauri";

/**
 * v3.5 §1.7 — Template detail view. Renders description, screenshots
 * (none in v3.5 stub), version history, dependency tree, and the 1-click
 * install button.
 */
export function TemplateDetail({
  template,
  installed,
  onInstallChange,
}: {
  template: Template;
  installed: boolean;
  onInstallChange: () => void;
}) {
  const pushToast = useStore((s) => s.ui.pushToast);
  const currentUser = useStore((s) => s.ui.currentUser);
  const [busy, setBusy] = useState(false);

  const isPlatformCurated = template.author === "tangerine";
  const isFree = template.price_cents === 0;

  async function handleInstall() {
    setBusy(true);
    try {
      await marketplaceInstallTemplate(template.id, currentUser);
      pushToast("success", `Installed ${template.name}`);
      onInstallChange();
    } catch (e) {
      pushToast("error", `Install failed: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleUninstall() {
    setBusy(true);
    try {
      await marketplaceUninstallTemplate(template.id);
      pushToast("info", `Uninstalled ${template.name}`);
      onInstallChange();
    } catch (e) {
      pushToast("error", `Uninstall failed: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="space-y-6">
      <header className="space-y-2">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <h1 className="text-[20px] font-semibold tracking-tight text-stone-900 dark:text-stone-100">
              {template.name}
            </h1>
            <p className="mt-1 text-[13px] text-stone-500 dark:text-stone-400">
              by {template.author} · v{template.version}
              {isPlatformCurated && (
                <span className="ml-2 inline-flex items-center gap-0.5 rounded bg-[var(--ti-orange-50)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--ti-orange-700)] dark:bg-stone-800 dark:text-[var(--ti-orange-500)]">
                  <Star size={11} />
                  Platform-curated
                </span>
              )}
            </p>
          </div>
          <PriceTag template={template} />
        </div>
      </header>

      <section className="space-y-2">
        <h2 className="ti-section-label">Description</h2>
        <p className="whitespace-pre-line text-[13px] leading-relaxed text-stone-700 dark:text-stone-300">
          {template.description}
        </p>
      </section>

      <section className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat icon={Tag} label="Vertical" value={template.vertical} capitalize />
        <Stat icon={Download} label="Installs" value={String(template.install_count)} />
        <Stat icon={GitBranch} label="Version" value={template.version} mono />
        <Stat
          icon={CheckCircle2}
          label="Take rate"
          value={isFree ? "—" : `${(template.take_rate / 100).toFixed(0)}%`}
        />
      </section>

      {template.dependencies.length > 0 && (
        <section className="space-y-2">
          <h2 className="ti-section-label">Dependencies</h2>
          <ul className="space-y-1 text-[12px] text-stone-700 dark:text-stone-300">
            {template.dependencies.map((dep) => (
              <li key={dep} className="font-mono">
                · {dep}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="flex items-center gap-2">
        {installed ? (
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={handleUninstall}
            data-testid="template-uninstall"
          >
            {busy ? "Uninstalling…" : "Uninstall"}
          </Button>
        ) : (
          <Button
            type="button"
            disabled={busy}
            onClick={handleInstall}
            data-testid="template-install"
          >
            {busy ? "Installing…" : isFree ? "Install free" : `Install for $${(template.price_cents / 100).toFixed(2)}`}
          </Button>
        )}
        {installed && (
          <span className="text-[12px] text-emerald-600 dark:text-emerald-400">
            Installed for team
          </span>
        )}
      </section>
    </article>
  );
}

function PriceTag({ template }: { template: Template }) {
  if (template.price_cents === 0) {
    return (
      <span className="rounded-md bg-emerald-50 px-3 py-1 text-[13px] font-medium text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400">
        Free
      </span>
    );
  }
  return (
    <span className="rounded-md bg-stone-100 px-3 py-1 font-mono text-[13px] text-stone-900 dark:bg-stone-800 dark:text-stone-100">
      ${(template.price_cents / 100).toFixed(2)}
    </span>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
  mono,
  capitalize,
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  label: string;
  value: string;
  mono?: boolean;
  capitalize?: boolean;
}) {
  return (
    <div className="rounded-md border border-stone-200 bg-stone-50 p-3 dark:border-stone-800 dark:bg-stone-900/40">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-stone-500 dark:text-stone-400">
        <Icon size={10} className="shrink-0" />
        {label}
      </div>
      <div
        className={
          "mt-1 text-[14px] text-stone-900 dark:text-stone-100" +
          (mono ? " font-mono" : "") +
          (capitalize ? " capitalize" : "")
        }
      >
        {value}
      </div>
    </div>
  );
}
