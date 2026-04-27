/**
 * PR-0 Prep — chat-style stdin/stdout to `tmi prep` subprocess.
 *
 * Spec: APP-INTERFACES.md §3 PR-0. Left = transcript pane (60%), right = intent
 * skeleton (40%). User types → run_tmi_send_stdin; stdout → bubbles in pane.
 * `done` literal locks intent.
 */
import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { runTmiInteractive, type RunHandle } from "@/lib/tauri";

interface ChatLine {
  id: number;
  source: "stdout" | "stderr" | "user" | "system";
  text: string;
}

export default function PrepSession() {
  const { id } = useParams<{ id: string }>();
  const [params] = useSearchParams();
  const alias = params.get("alias") ?? "daizhe";
  const nav = useNavigate();
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [input, setInput] = useState("");
  const [run, setRun] = useState<RunHandle | null>(null);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const idCounter = useRef(0);

  useEffect(() => {
    if (!id) return;
    let active = true;
    let unsubs: Array<() => void> = [];

    runTmiInteractive("prep", [id, "--alias", alias]).then((h) => {
      if (!active) return;
      setRun(h);
      unsubs.push(
        h.onStdout((l) => {
          setLines((prev) => [
            ...prev,
            { id: idCounter.current++, source: "stdout", text: l },
          ]);
        })
      );
      unsubs.push(
        h.onStderr((l) => {
          setLines((prev) => [
            ...prev,
            { id: idCounter.current++, source: "stderr", text: l },
          ]);
        })
      );
      unsubs.push(
        h.onExit((code) => {
          setExitCode(code);
          setLines((prev) => [
            ...prev,
            {
              id: idCounter.current++,
              source: "system",
              text: code === 0 ? "intent locked, returning to meeting" : `exited code=${code}`,
            },
          ]);
          if (code === 0 && id) {
            setTimeout(() => nav(`/meetings/${id}`), 800);
          }
        })
      );
    });

    return () => {
      active = false;
      unsubs.forEach((u) => u());
      // best-effort kill
    };
  }, [id, alias, nav]);

  const send = async (text: string) => {
    if (!run || !text.trim()) return;
    setLines((prev) => [
      ...prev,
      { id: idCounter.current++, source: "user", text },
    ]);
    setInput("");
    await run.send(text);
  };

  return (
    <div className="grid h-full grid-cols-[3fr_2fr] gap-0 divide-x divide-[var(--ti-border-faint)]" data-testid="pr-0">
      <section className="flex flex-col">
        <header className="flex items-center justify-between border-b border-[var(--ti-border-faint)] bg-[var(--ti-paper-50)] px-4 py-3">
          <div>
            <h1 className="font-display text-lg">Prep · {alias}</h1>
            <p className="text-xs text-[var(--ti-ink-500)] font-mono">{id}</p>
          </div>
          {exitCode === null ? (
            <span className="text-xs text-[var(--ti-ink-500)]">streaming…</span>
          ) : (
            <span className="text-xs text-[var(--ti-ink-500)]">exited ({exitCode})</span>
          )}
        </header>

        <ol className="flex-1 overflow-auto p-4 space-y-2 text-sm">
          {lines.map((l) => (
            <li
              key={l.id}
              className={
                l.source === "user"
                  ? "text-right"
                  : l.source === "stderr"
                    ? "text-[var(--ti-danger)]"
                    : l.source === "system"
                      ? "italic text-[var(--ti-ink-500)]"
                      : ""
              }
            >
              <span
                className={
                  "inline-block max-w-[80%] rounded-md px-3 py-1.5 text-left " +
                  (l.source === "user"
                    ? "bg-[var(--ti-orange-50)] text-[var(--ti-orange-700)]"
                    : "bg-[var(--ti-paper-100)] font-mono text-xs text-[var(--ti-ink-700)]")
                }
              >
                {l.text}
              </span>
            </li>
          ))}
        </ol>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send(input);
          }}
          className="flex gap-2 border-t border-[var(--ti-border-faint)] p-3"
        >
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                void send(input);
              }
            }}
            placeholder="Type your reply (Cmd/Ctrl+Enter to send)"
            disabled={exitCode !== null}
            rows={2}
            className="flex-1 rounded-md border border-[var(--ti-border-default)] bg-[var(--ti-paper-50)] px-3 py-2 font-mono text-xs"
          />
          <div className="flex flex-col gap-2">
            <Button type="submit" disabled={!input.trim() || exitCode !== null} size="sm">
              Send
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void send("done")}
              disabled={exitCode !== null}
              title="Lock intent"
            >
              Done
            </Button>
          </div>
        </form>
      </section>

      <aside className="flex flex-col gap-3 p-4">
        <h2 className="ti-section-label">Intent skeleton</h2>
        <p className="text-xs text-[var(--ti-ink-500)]">
          Topics, questions and decisions you raise are stitched into{" "}
          <code className="font-mono">intents/{alias}.md</code> when you say{" "}
          <code className="font-mono">done</code>.
        </p>
        <pre className="flex-1 overflow-auto rounded-md border border-[var(--ti-border-faint)] bg-[var(--ti-paper-100)] p-3 font-mono text-xs text-[var(--ti-ink-700)]">
{`# Intent — ${alias}

## Topics

(filled in as you describe what's on your mind)

## Questions

(extracted on the fly)
`}
        </pre>
      </aside>
    </div>
  );
}
