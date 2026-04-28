import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import {
  readThread,
  markAtomViewed,
  type ThreadDetailData,
} from "@/lib/views";
import { useStore } from "@/lib/store";
import { TangerineNotes } from "@/components/TangerineNotes";
import { ThreadView } from "@/components/ThreadView";

export default function ThreadDetailRoute() {
  const params = useParams();
  const topic = decodeURIComponent(params.topic ?? "");
  const currentUser = useStore((s) => s.ui.currentUser);
  const [data, setData] = useState<ThreadDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  // === v1.13.8 round-8 === — readThread re-throws on Tauri failure
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancel = false;
    if (!topic) return;
    setLoading(true);
    setError(null);
    readThread(topic)
      .then((d) => {
        if (cancel) return;
        setData(d);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (cancel) return;
        setError(typeof e === "string" ? e : (e as Error)?.message ?? "Could not read thread.");
        setLoading(false);
      });
    return () => {
      cancel = true;
    };
  }, [topic]);

  const onAtomViewed = (atomId: string) => {
    void markAtomViewed(currentUser, atomId);
  };

  return (
    <div className="bg-stone-50 dark:bg-stone-950">
      <div className="mx-auto max-w-3xl px-8 py-10">
        <div className="mb-6">
          <Link
            to="/threads"
            className="inline-flex items-center gap-1 font-mono text-[11px] text-stone-500 hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100"
          >
            <ArrowLeft size={12} /> /threads
          </Link>
        </div>
        <TangerineNotes notes={data?.notes ?? []} route={`threads:${topic}`} />
        {loading ? (
          <p className="text-[12px] text-stone-500 dark:text-stone-400">Loading…</p>
        ) : error ? (
          // === v1.13.8 round-8 === — armed error UI
          <div role="alert" data-testid="thread-detail-error" className="rounded-md border border-rose-200 bg-rose-50 px-4 py-3 dark:border-rose-900 dark:bg-rose-950/30">
            <p className="text-[12px] text-rose-700 dark:text-rose-300">Couldn't read thread #{topic}.</p>
            <p className="mt-1 font-mono text-[10px] text-rose-600 dark:text-rose-400">{error}</p>
          </div>
        ) : data ? (
          <ThreadView data={data} onAtomViewed={onAtomViewed} />
        ) : (
          <p className="text-[12px] text-stone-500 dark:text-stone-400">
            No data for #{topic}.
          </p>
        )}
      </div>
    </div>
  );
}
