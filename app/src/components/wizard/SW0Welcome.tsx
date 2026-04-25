import { Button } from "@/components/ui/button";
import { useStore } from "@/lib/store";

export function SW0Welcome() {
  const next = useStore((s) => s.wizard.next);

  return (
    <div className="flex h-full flex-col items-center justify-center text-center">
      <div
        className="mb-6 h-14 w-14 rounded-2xl"
        style={{ background: "var(--ti-orange-500)" }}
      />
      <h1 className="font-display text-4xl tracking-tight text-[var(--ti-ink-900)]">
        Welcome to Tangerine AI Teams.
      </h1>
      <p className="mt-4 max-w-xl text-base text-[var(--ti-ink-700)]">
        Your meeting becomes your team's AI context, automatically. We will set up Discord,
        Whisper, and your Claude Code project. Takes about 5 minutes.
      </p>
      <Button size="lg" className="mt-10" onClick={next}>
        Get started →
      </Button>
    </div>
  );
}
