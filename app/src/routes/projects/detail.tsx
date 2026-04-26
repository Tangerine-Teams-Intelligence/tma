import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import {
  readProject,
  markAtomViewed,
  type ProjectDetailData,
} from "@/lib/views";
import { useStore } from "@/lib/store";
import { TangerineNotes } from "@/components/TangerineNotes";
import { ProjectView } from "@/components/ProjectView";

export default function ProjectDetailRoute() {
  const params = useParams();
  const slug = decodeURIComponent(params.slug ?? "");
  const currentUser = useStore((s) => s.ui.currentUser);
  const [data, setData] = useState<ProjectDetailData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancel = false;
    if (!slug) return;
    setLoading(true);
    void readProject(slug).then((d) => {
      if (cancel) return;
      setData(d);
      setLoading(false);
    });
    return () => {
      cancel = true;
    };
  }, [slug]);

  const onAtomViewed = (atomId: string) => {
    void markAtomViewed(currentUser, atomId);
  };

  return (
    <div className="bg-stone-50 dark:bg-stone-950">
      <div className="mx-auto max-w-3xl px-8 py-10">
        <div className="mb-6">
          <Link
            to="/projects"
            className="inline-flex items-center gap-1 font-mono text-[11px] text-stone-500 hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100"
          >
            <ArrowLeft size={12} /> /projects
          </Link>
        </div>
        <TangerineNotes notes={data?.notes ?? []} route={`projects:${slug}`} />
        {loading ? (
          <p className="text-[12px] text-stone-500 dark:text-stone-400">Loading…</p>
        ) : data ? (
          <ProjectView data={data} onAtomViewed={onAtomViewed} />
        ) : (
          <p className="text-[12px] text-stone-500 dark:text-stone-400">
            No data for {slug}.
          </p>
        )}
      </div>
    </div>
  );
}
