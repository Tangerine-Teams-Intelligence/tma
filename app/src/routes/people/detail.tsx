import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import {
  readPerson,
  markAtomViewed,
  type PersonDetailData,
} from "@/lib/views";
import { useStore } from "@/lib/store";
import { TangerineNotes } from "@/components/TangerineNotes";
import { PersonView } from "@/components/PersonView";

/**
 * /people/:alias — detail page. Loads readPerson(alias) and renders
 * <PersonView/>. Updates cursor.atoms_viewed when the user clicks an atom
 * row to drill in.
 */
export default function PersonDetailRoute() {
  const params = useParams();
  const alias = decodeURIComponent(params.alias ?? "");
  const currentUser = useStore((s) => s.ui.currentUser);
  const [data, setData] = useState<PersonDetailData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancel = false;
    if (!alias) return;
    setLoading(true);
    void readPerson(alias).then((d) => {
      if (cancel) return;
      setData(d);
      setLoading(false);
    });
    return () => {
      cancel = true;
    };
  }, [alias]);

  const onAtomViewed = (atomId: string) => {
    void markAtomViewed(currentUser, atomId);
  };

  return (
    <div className="bg-stone-50 dark:bg-stone-950">
      <div className="mx-auto max-w-3xl px-8 py-10">
        <div className="mb-6">
          <Link
            to="/people"
            className="inline-flex items-center gap-1 font-mono text-[11px] text-stone-500 hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100"
          >
            <ArrowLeft size={12} /> /people
          </Link>
        </div>

        <TangerineNotes
          notes={data?.notes ?? []}
          route={`people:${alias}`}
        />

        {loading ? (
          <p className="text-[12px] text-stone-500 dark:text-stone-400">Loading…</p>
        ) : data ? (
          <PersonView data={data} onAtomViewed={onAtomViewed} />
        ) : (
          <p className="text-[12px] text-stone-500 dark:text-stone-400">
            No data for @{alias}.
          </p>
        )}
      </div>
    </div>
  );
}
