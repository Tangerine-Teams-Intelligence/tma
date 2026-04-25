import { Link, useNavigate } from "react-router-dom";
import { Plus, Mic, LogOut, Settings as SettingsIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useStore, listInstalledSkills } from "@/lib/store";
import { useAuth, signOut } from "@/lib/auth";

export default function DashboardRoute() {
  const meetingConfig = useStore((s) => s.skills.meetingConfig);
  const installed = listInstalledSkills(meetingConfig);
  const { email } = useAuth();
  const navigate = useNavigate();

  async function handleSignOut() {
    await signOut();
    navigate("/auth", { replace: true });
  }

  return (
    <div className="min-h-full bg-[var(--ti-paper-100)]">
      {/* Top chrome */}
      <header className="ti-no-select flex h-14 items-center justify-between border-b border-[var(--ti-border-faint)] bg-[var(--ti-paper-100)] px-6">
        <div className="flex items-center gap-3">
          <div
            className="h-7 w-7 rounded-md"
            style={{ background: "var(--ti-orange-500)" }}
            aria-hidden
          />
          <span className="font-display text-lg leading-none text-[var(--ti-ink-900)]">
            Tangerine
          </span>
          <span className="text-xs text-[var(--ti-ink-500)]">/ Dashboard</span>
        </div>
        <div className="flex items-center gap-2">
          {email && (
            <span className="text-xs text-[var(--ti-ink-500)]">{email}</span>
          )}
          <Button
            variant="ghost"
            size="icon"
            aria-label="Settings"
            onClick={() => navigate("/settings")}
          >
            <SettingsIcon size={16} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Sign out"
            onClick={handleSignOut}
            title="Sign out"
          >
            <LogOut size={16} />
          </Button>
        </div>
      </header>

      <main className="mx-auto max-w-5xl p-8">
        <div className="flex items-end justify-between">
          <div>
            <h1 className="font-display text-3xl tracking-tight text-[var(--ti-ink-900)]">
              Your skills
            </h1>
            <p className="mt-2 text-sm text-[var(--ti-ink-700)]">
              Each skill is an AI teammate. Install one, configure it, then run it.
            </p>
          </div>
          <Link to="/skills">
            <Button>
              <Plus size={16} /> Add skill
            </Button>
          </Link>
        </div>

        <div className="mt-8">
          {installed.length === 0 ? (
            <EmptyState />
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {installed.includes("meeting") && (
                <InstalledSkillCard
                  id="meeting"
                  title="Meeting"
                  blurb="Live transcription + Discord bot + Claude review per meeting."
                  icon={<Mic size={18} />}
                  onOpen={() => navigate("/")}
                  onConfigure={() => navigate("/skills/meeting")}
                />
              )}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="rounded-lg border border-dashed border-[var(--ti-border-default)] p-16 text-center">
      <div
        className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full"
        style={{ background: "var(--ti-orange-50)" }}
      >
        <Plus size={20} className="text-[var(--ti-orange-500)]" />
      </div>
      <h2 className="font-display text-xl text-[var(--ti-ink-900)]">No skills installed</h2>
      <p className="mt-2 text-sm text-[var(--ti-ink-700)]">
        Add your first skill to get started. Meeting is the only one shipping in v1.5.
      </p>
      <Link to="/skills" className="mt-6 inline-block">
        <Button size="lg">
          <Plus size={16} /> Add your first skill
        </Button>
      </Link>
    </div>
  );
}

interface InstalledSkillCardProps {
  id: string;
  title: string;
  blurb: string;
  icon: React.ReactNode;
  onOpen: () => void;
  onConfigure: () => void;
}

function InstalledSkillCard({ title, blurb, icon, onOpen, onConfigure }: InstalledSkillCardProps) {
  return (
    <Card className="transition-shadow hover:shadow-md">
      <CardContent className="pt-6">
        <div className="flex items-start gap-3">
          <div
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md"
            style={{ background: "var(--ti-orange-50)", color: "var(--ti-orange-700)" }}
          >
            {icon}
          </div>
          <div className="min-w-0 flex-1">
            <p className="font-medium text-[var(--ti-ink-900)]">{title}</p>
            <p className="mt-1 text-xs text-[var(--ti-ink-700)]">{blurb}</p>
          </div>
        </div>
        <div className="mt-4 flex items-center justify-between gap-2">
          <Button variant="outline" size="sm" onClick={onConfigure}>
            Configure
          </Button>
          <Button size="sm" onClick={onOpen}>
            Open →
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
