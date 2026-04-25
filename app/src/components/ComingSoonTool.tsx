import { Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { findTool, type ToolId } from "@/lib/tools";

interface Props {
  id: ToolId;
}

/**
 * Stub page for tools that aren't shipping in v1.5. Not a "blocked" wall —
 * shows what the tool does and when it's coming.
 */
export function ComingSoonTool({ id }: Props) {
  const tool = findTool(id);
  const Icon = tool.icon;

  return (
    <div className="mx-auto max-w-3xl px-8 py-10">
      <div className="mb-6">
        <Link
          to="/home"
          className="inline-flex items-center gap-1 text-xs text-[var(--ti-ink-500)] hover:text-[var(--ti-ink-900)]"
        >
          <ArrowLeft size={12} /> Home
        </Link>
      </div>

      <div className="flex items-center gap-4">
        <div
          className="flex h-12 w-12 items-center justify-center rounded-lg"
          style={{ background: "var(--ti-paper-200)", color: "var(--ti-ink-500)" }}
        >
          <Icon size={22} />
        </div>
        <div>
          <h1 className="font-display text-3xl tracking-tight text-[var(--ti-ink-900)]">
            {tool.title}
          </h1>
          {tool.comingIn && (
            <p className="mt-1 text-xs font-medium uppercase tracking-wider text-[var(--ti-orange-700)]">
              Coming {tool.comingIn}
            </p>
          )}
        </div>
      </div>

      <Card className="mt-8">
        <CardContent className="p-6">
          <h2 className="font-display text-xl text-[var(--ti-ink-900)]">What this will do</h2>
          <p className="mt-3 text-sm leading-relaxed text-[var(--ti-ink-700)]">
            {tool.longBlurb}
          </p>
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardContent className="p-6">
          <h2 className="font-display text-xl text-[var(--ti-ink-900)]">
            Why it lives here
          </h2>
          <p className="mt-3 text-sm leading-relaxed text-[var(--ti-ink-700)]">
            Tangerine AI Teams is one app that consolidates the 10 productivity tools your
            team would otherwise stitch together. {tool.title} is built into the same shell
            as every other tool — one login, one subscription, one place where the data
            lives. No new tab to open, no new account to manage.
          </p>
        </CardContent>
      </Card>

      <div className="mt-6 flex items-center justify-between">
        <p className="text-xs text-[var(--ti-ink-500)]">
          Want this sooner? Tell us what you need at{" "}
          <a
            href="mailto:daizhe@berkeley.edu"
            className="text-[var(--ti-orange-500)] underline-offset-2 hover:underline"
          >
            daizhe@berkeley.edu
          </a>
          .
        </p>
        <Link to="/home">
          <Button variant="outline" size="sm">
            Back to home
          </Button>
        </Link>
      </div>
    </div>
  );
}
