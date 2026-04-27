import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import {
  marketplaceIsInstalled,
  marketplaceListTemplates,
  type Template,
} from "@/lib/tauri";
import { useStore } from "@/lib/store";
import { TemplateDetail } from "@/components/marketplace/TemplateDetail";

/**
 * /marketplace/:id — v3.5 §1.7 per-template detail page.
 *
 * Loads the full catalog and finds the matching id (in production this
 * would be a single-template fetch; the stub doesn't have that endpoint
 * so we filter the list). The user can install / uninstall from this
 * page.
 *
 * Wave 2: the "Already installed" state is sourced from the new
 * `marketplace_is_installed` backend command rather than `install_count > 0`,
 * so the badge tracks the **current team** instead of any team on the box.
 */
export default function MarketplaceDetailRoute() {
  const { id } = useParams<{ id: string }>();
  const currentUser = useStore((s) => s.ui.currentUser);
  const [template, setTemplate] = useState<Template | null>(null);
  const [installed, setInstalled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [reloadCounter, setReloadCounter] = useState(0);

  useEffect(() => {
    if (!id) return;
    let cancel = false;
    void (async () => {
      const [rows, isInstalled] = await Promise.all([
        marketplaceListTemplates(),
        marketplaceIsInstalled(id, currentUser),
      ]);
      if (cancel) return;
      const t = rows.find((r) => r.id === id) ?? null;
      setTemplate(t);
      setInstalled(isInstalled);
      setLoading(false);
    })();
    return () => {
      cancel = true;
    };
  }, [id, reloadCounter, currentUser]);

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
