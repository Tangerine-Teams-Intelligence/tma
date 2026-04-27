import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import {
  marketplaceListTemplates,
  type Template,
} from "@/lib/tauri";
import { TemplateDetail } from "@/components/marketplace/TemplateDetail";

/**
 * /marketplace/:id — v3.5 §1.7 per-template detail page.
 *
 * Loads the full catalog and finds the matching id (in production this
 * would be a single-template fetch; the stub doesn't have that endpoint
 * so we filter the list). The user can install / uninstall from this
 * page.
 */
export default function MarketplaceDetailRoute() {
  const { id } = useParams<{ id: string }>();
  const [template, setTemplate] = useState<Template | null>(null);
  const [installed, setInstalled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [reloadCounter, setReloadCounter] = useState(0);

  useEffect(() => {
    if (!id) return;
    let cancel = false;
    void (async () => {
      const rows = await marketplaceListTemplates();
      if (cancel) return;
      const t = rows.find((r) => r.id === id) ?? null;
      setTemplate(t);
      // We treat install_count > 0 as "installed for the current team" in
      // stub mode since the stub records every install in `installs.json`
      // and the user's team is the only team on the box.
      setInstalled(t !== null && t.install_count > 0);
      setLoading(false);
    })();
    return () => {
      cancel = true;
    };
  }, [id, reloadCounter]);

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-8">
      <Link
        to="/marketplace"
        className="mb-4 inline-flex items-center gap-1 text-[12px] text-stone-500 hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100"
      >
        <ArrowLeft size={12} />
        Back to marketplace
      </Link>

      {loading ? (
        <p className="text-[13px] text-stone-500 dark:text-stone-400">Loading…</p>
      ) : template === null ? (
        <p className="text-[13px] text-stone-600 dark:text-stone-400">
          Template <code>{id}</code> not found in the catalog.
        </p>
      ) : (
        <TemplateDetail
          template={template}
          installed={installed}
          onInstallChange={() => setReloadCounter((n) => n + 1)}
        />
      )}
    </div>
  );
}
