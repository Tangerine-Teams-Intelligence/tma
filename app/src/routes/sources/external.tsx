/**
 * v3.0 §2 — External world capture setup page.
 *
 * One page covers all four sub-sources (RSS / Podcast / YouTube /
 * Article) because they share opt-in patterns: paste a URL, we capture it.
 * v3.0 §5.1 demands per-source toggles — we render one panel per kind plus
 * the "fetch now" + "manage subscriptions" buttons.
 *
 * Atoms write to `~/.tangerine-memory/personal/<user>/threads/external/<kind>/`.
 */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, Globe, Plus, RefreshCw, Trash2, Youtube } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import {
  externalArticleCapture,
  externalPodcastFetchNow,
  externalPodcastListFeeds,
  externalPodcastSubscribe,
  externalPodcastUnsubscribe,
  externalRssFetchNow,
  externalRssListFeeds,
  externalRssSubscribe,
  externalRssUnsubscribe,
  externalYoutubeCapture,
  type ExternalRssFeed,
  type ExternalPodcastFeed,
} from "@/lib/tauri";
import { useStore } from "@/lib/store";

export default function ExternalSourceRoute() {
  const navigate = useNavigate();
  const pushToast = useStore((s) => s.ui.pushToast);

  const [rssFeeds, setRssFeeds] = useState<ExternalRssFeed[]>([]);
  const [podcastFeeds, setPodcastFeeds] = useState<ExternalPodcastFeed[]>([]);
  const [rssUrl, setRssUrl] = useState("");
  const [podcastUrl, setPodcastUrl] = useState("");
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [articleUrl, setArticleUrl] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    void refreshAll();
  }, []);

  async function refreshAll() {
    try {
      const [r, p] = await Promise.all([
        externalRssListFeeds(),
        externalPodcastListFeeds(),
      ]);
      setRssFeeds(r);
      setPodcastFeeds(p);
    } catch (e) {
      // Best-effort — empty list is a safe fallback.
      setRssFeeds([]);
      setPodcastFeeds([]);
    }
  }

  async function handleAddRss() {
    if (!rssUrl.trim()) return;
    setBusy("rss-add");
    try {
      const list = await externalRssSubscribe({ url: rssUrl.trim() });
      setRssFeeds(list);
      setRssUrl("");
      pushToast("success", "RSS feed added.");
    } catch (e) {
      pushToast("error", `Add feed failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  async function handleRemoveRss(url: string) {
    setBusy(`rss-${url}`);
    try {
      const list = await externalRssUnsubscribe({ url });
      setRssFeeds(list);
    } finally {
      setBusy(null);
    }
  }

  async function handleFetchRss() {
    setBusy("rss-fetch");
    try {
      const r = await externalRssFetchNow();
      pushToast(
        "success",
        `RSS: ${r.atoms_written} new, ${r.items_seen} seen.`,
      );
    } catch (e) {
      pushToast("error", `Fetch failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  async function handleAddPodcast() {
    if (!podcastUrl.trim()) return;
    setBusy("podcast-add");
    try {
      const list = await externalPodcastSubscribe({
        url: podcastUrl.trim(),
        transcribe: false,
      });
      setPodcastFeeds(list);
      setPodcastUrl("");
      pushToast("success", "Podcast feed added.");
    } catch (e) {
      pushToast("error", `Add podcast failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  async function handleRemovePodcast(url: string) {
    setBusy(`podcast-${url}`);
    try {
      const list = await externalPodcastUnsubscribe({ url });
      setPodcastFeeds(list);
    } finally {
      setBusy(null);
    }
  }

  async function handleFetchPodcast() {
    setBusy("podcast-fetch");
    try {
      const r = await externalPodcastFetchNow();
      pushToast(
        "success",
        `Podcast: ${r.atoms_written} new, ${r.items_seen} seen.`,
      );
    } catch (e) {
      pushToast("error", `Fetch failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  async function handleCaptureYoutube() {
    if (!youtubeUrl.trim()) return;
    setBusy("youtube");
    try {
      const r = await externalYoutubeCapture({
        request: { url: youtubeUrl.trim() },
      });
      if (r.atoms_written > 0) {
        pushToast("success", "YouTube transcript captured.");
        setYoutubeUrl("");
      } else if (r.errors.length > 0) {
        pushToast("error", r.errors[0]);
      } else {
        pushToast("info", "Already captured.");
      }
    } catch (e) {
      pushToast("error", `YouTube capture failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  async function handleCaptureArticle() {
    if (!articleUrl.trim()) return;
    setBusy("article");
    try {
      const r = await externalArticleCapture({
        request: { url: articleUrl.trim() },
      });
      if (r.atoms_written > 0) {
        pushToast("success", "Article captured.");
        setArticleUrl("");
      } else if (r.errors.length > 0) {
        pushToast("error", r.errors[0]);
      } else {
        pushToast("info", "Already captured.");
      }
    } catch (e) {
      pushToast("error", `Article capture failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="min-h-full bg-stone-50 dark:bg-stone-950">
      <header className="ti-no-select flex h-14 items-center gap-3 border-b border-stone-200 bg-stone-50 px-6 dark:border-stone-800 dark:bg-stone-950">
        <Button
          variant="ghost"
          size="icon"
          aria-label="Back"
          onClick={() => navigate("/memory")}
        >
          <ArrowLeft size={16} />
        </Button>
        <div
          className="flex h-7 w-7 items-center justify-center rounded-md"
          style={{ background: "var(--ti-orange-50)", color: "var(--ti-orange-700)" }}
        >
          <Globe size={14} />
        </div>
        <span className="font-display text-lg leading-none text-stone-900 dark:text-stone-100">
          External
        </span>
        <span className="font-mono text-[11px] text-stone-500 dark:text-stone-400">
          / Source / Set up
        </span>
      </header>

      <main className="mx-auto max-w-3xl p-8 pb-24 space-y-8">
        <div>
          <p className="ti-section-label">Source · External world</p>
          <h1 className="mt-1 font-display text-3xl tracking-tight text-stone-900 dark:text-stone-100">
            Read what you read
          </h1>
          <p className="mt-2 text-sm text-stone-700 dark:text-stone-300">
            Subscribe to RSS feeds and podcasts; paste any YouTube URL or article link.
            Every captured item lands as a markdown atom under
            {" "}
            <code className="font-mono text-[12px]">
              ~/.tangerine-memory/personal/&lt;you&gt;/threads/external/
            </code>
            . Personal vault — never synced to the team.
          </p>
        </div>

        {/* RSS */}
        <Card>
          <CardContent className="space-y-4 pt-6">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="font-display text-xl">RSS feeds</h2>
                <p className="text-xs text-stone-500">
                  Daily fetch via the daemon; one atom per new entry.
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={handleFetchRss}
                disabled={busy === "rss-fetch" || rssFeeds.length === 0}
              >
                <RefreshCw size={14} className="mr-1.5" />
                Fetch now
              </Button>
            </div>
            <div className="flex items-end gap-2">
              <div className="flex-1 space-y-2">
                <Label htmlFor="rss-url">Feed URL</Label>
                <Input
                  id="rss-url"
                  value={rssUrl}
                  onChange={(e) => setRssUrl(e.target.value)}
                  placeholder="https://stratechery.com/feed/"
                />
              </div>
              <Button onClick={handleAddRss} disabled={busy === "rss-add" || !rssUrl.trim()}>
                <Plus size={14} className="mr-1.5" />
                Add
              </Button>
            </div>
            {rssFeeds.length > 0 && (
              <ul className="space-y-1.5">
                {rssFeeds.map((f) => (
                  <li
                    key={f.url}
                    className="flex items-center justify-between rounded-md border border-stone-200 px-3 py-2 text-sm dark:border-stone-800"
                  >
                    <span className="truncate font-mono text-xs">
                      {f.title ?? f.url}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Remove feed"
                      disabled={busy === `rss-${f.url}`}
                      onClick={() => handleRemoveRss(f.url)}
                    >
                      <Trash2 size={14} />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* Podcast */}
        <Card>
          <CardContent className="space-y-4 pt-6">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="font-display text-xl">Podcasts</h2>
                <p className="text-xs text-stone-500">
                  Subscribe to the RSS; transcripts are off by default (heavy on CPU).
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={handleFetchPodcast}
                disabled={busy === "podcast-fetch" || podcastFeeds.length === 0}
              >
                <RefreshCw size={14} className="mr-1.5" />
                Fetch now
              </Button>
            </div>
            <div className="flex items-end gap-2">
              <div className="flex-1 space-y-2">
                <Label htmlFor="podcast-url">Podcast feed URL</Label>
                <Input
                  id="podcast-url"
                  value={podcastUrl}
                  onChange={(e) => setPodcastUrl(e.target.value)}
                  placeholder="https://lexfridman.com/feed/podcast/"
                />
              </div>
              <Button
                onClick={handleAddPodcast}
                disabled={busy === "podcast-add" || !podcastUrl.trim()}
              >
                <Plus size={14} className="mr-1.5" />
                Add
              </Button>
            </div>
            {podcastFeeds.length > 0 && (
              <ul className="space-y-1.5">
                {podcastFeeds.map((f) => (
                  <li
                    key={f.url}
                    className="flex items-center justify-between rounded-md border border-stone-200 px-3 py-2 text-sm dark:border-stone-800"
                  >
                    <span className="truncate font-mono text-xs">
                      {f.title ?? f.url}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Remove podcast"
                      disabled={busy === `podcast-${f.url}`}
                      onClick={() => handleRemovePodcast(f.url)}
                    >
                      <Trash2 size={14} />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* YouTube */}
        <Card>
          <CardContent className="space-y-4 pt-6">
            <div>
              <h2 className="font-display text-xl flex items-center gap-2">
                <Youtube size={18} /> YouTube
              </h2>
              <p className="text-xs text-stone-500">
                Paste any YouTube URL — we capture the transcript via captions.
              </p>
            </div>
            <div className="flex items-end gap-2">
              <div className="flex-1 space-y-2">
                <Label htmlFor="yt-url">Video URL</Label>
                <Input
                  id="yt-url"
                  value={youtubeUrl}
                  onChange={(e) => setYoutubeUrl(e.target.value)}
                  placeholder="https://youtube.com/watch?v=..."
                />
              </div>
              <Button
                onClick={handleCaptureYoutube}
                disabled={busy === "youtube" || !youtubeUrl.trim()}
              >
                Capture
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Generic article */}
        <Card>
          <CardContent className="space-y-4 pt-6">
            <div>
              <h2 className="font-display text-xl">Article</h2>
              <p className="text-xs text-stone-500">
                Paste any web URL — we extract the main content as an atom.
              </p>
            </div>
            <div className="flex items-end gap-2">
              <div className="flex-1 space-y-2">
                <Label htmlFor="article-url">Article URL</Label>
                <Input
                  id="article-url"
                  value={articleUrl}
                  onChange={(e) => setArticleUrl(e.target.value)}
                  placeholder="https://example.com/post"
                />
              </div>
              <Button
                onClick={handleCaptureArticle}
                disabled={busy === "article" || !articleUrl.trim()}
              >
                Capture
              </Button>
            </div>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
