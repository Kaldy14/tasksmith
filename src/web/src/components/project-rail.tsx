import { useMemo, useState } from "react";
import { Link, useParams } from "@tanstack/react-router";
import { ChevronDown, ChevronRight, Folder, Plus, Settings, Wifi } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { IntakeForm } from "./intake-form";
import { cn, formatRelativeTime } from "@/lib/utils";
import type { ConnectionStatus, RunRecord, RunStatus } from "@/types";

interface ProjectRailProps {
  runs: RunRecord[];
  loading: boolean;
  connection: ConnectionStatus;
  onCreated: () => void;
}

interface ProjectGroup {
  key: string;
  threads: RunRecord[];
  liveCount: number;
}

const ACTIVE: RunStatus[] = ["running", "preparing", "waiting_for_control", "verifying", "creating_pr"];

const CONNECTION_LABEL: Record<ConnectionStatus, string> = {
  idle: "idle",
  connecting: "connecting",
  online: "live",
  offline: "offline",
};

function groupByProject(runs: RunRecord[]): ProjectGroup[] {
  const map = new Map<string, RunRecord[]>();
  for (const run of runs) {
    const key = run.repoKey || "unfiled";
    const list = map.get(key) ?? [];
    list.push(run);
    map.set(key, list);
  }
  return Array.from(map.entries())
    .map(([key, threads]) => ({
      key,
      threads: [...threads].sort(
        (a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0),
      ),
      liveCount: threads.filter((t) => ACTIVE.includes(t.status)).length,
    }))
    .sort((a, b) => {
      const aMax = Math.max(...a.threads.map((t) => Date.parse(t.updatedAt) || 0));
      const bMax = Math.max(...b.threads.map((t) => Date.parse(t.updatedAt) || 0));
      return bMax - aMax;
    });
}

export function ProjectRail({ runs, loading, connection, onCreated }: ProjectRailProps) {
  const params = useParams({ strict: false }) as { runId?: string };
  const selected = params.runId;
  const [showIntake, setShowIntake] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const groups = useMemo(() => groupByProject(runs), [runs]);

  function toggle(key: string): void {
    setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  return (
    <aside className="flex w-[296px] shrink-0 flex-col border-r border-border bg-card text-foreground">
      <div className="flex h-14 shrink-0 items-center px-4">
        <Link to="/" className="min-w-0 truncate text-sm font-semibold tracking-tight text-foreground">
          TaskSmith
        </Link>
      </div>

      <div className="flex items-center justify-between px-4 pb-2 pt-4">
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
          Projects
        </span>
        <button
          type="button"
          className="grid size-6 place-items-center rounded-md text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
          aria-label="New run"
          onClick={() => setShowIntake((v) => !v)}
        >
          <Plus className="size-3.5" />
        </button>
      </div>

      {showIntake ? (
        <div className="mx-3 mb-3 rounded-xl border border-border bg-background/45 p-3">
          <IntakeForm
            onCreated={() => {
              setShowIntake(false);
              onCreated();
            }}
          />
        </div>
      ) : null}

      <ScrollArea className="min-h-0 flex-1">
        <div className="px-2 pb-3">
          {loading && groups.length === 0 ? (
            <p className="px-2 py-3 text-xs text-muted-foreground">Loading...</p>
          ) : groups.length === 0 ? (
            <p className="px-2 py-3 text-xs text-muted-foreground">No threads yet.</p>
          ) : (
            groups.map((g) => {
              const isCollapsed = collapsed[g.key] ?? false;
              return (
                <div key={g.key} className="mb-2">
                  <button
                    type="button"
                    onClick={() => toggle(g.key)}
                    className={cn(
                      "group flex h-8 w-full items-center gap-1.5 rounded-lg px-2 text-left text-sm",
                      "text-foreground/95 transition-colors hover:bg-accent",
                    )}
                  >
                    {isCollapsed ? (
                      <ChevronRight className="size-3.5 text-muted-foreground/65" />
                    ) : (
                      <ChevronDown className="size-3.5 text-muted-foreground/65" />
                    )}
                    <Folder className="size-4 shrink-0 text-muted-foreground/65" />
                    <span className="truncate font-semibold tracking-tight">{g.key}</span>
                    <span className="ml-auto flex items-center gap-1.5 text-[10px] text-muted-foreground/55">
                      {g.liveCount > 0 ? (
                        <span className="inline-block size-1.5 rounded-full bg-jade animate-pulse" />
                      ) : null}
                      <span>{g.threads.length}</span>
                    </span>
                  </button>
                  {!isCollapsed ? (
                    <div className="mt-0.5 space-y-0.5">
                      {g.threads.map((run) => (
                        <ThreadRow key={run.id} run={run} active={run.id === selected} />
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })
          )}
        </div>
      </ScrollArea>

      <div className="shrink-0 space-y-2 border-t border-border/70 px-3 py-3">
        <Link
          to="/config"
          className="flex h-8 items-center gap-2 rounded-lg bg-accent px-2 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          <Settings className="size-3.5" />
          Project config
        </Link>
        <div
          className={cn(
            "flex h-8 items-center gap-2 rounded-lg px-2 text-xs",
            connection === "online"
              ? "bg-primary/15 text-primary"
              : "bg-accent text-muted-foreground",
          )}
        >
          <Wifi className="size-3.5" />
          <span className="font-medium">{CONNECTION_LABEL[connection]}</span>
        </div>
      </div>
    </aside>
  );
}

function statusDotClass(status: RunStatus): string {
  if (status === "running" || status === "preparing" || status === "verifying" || status === "creating_pr") return "bg-primary";
  if (status === "waiting_for_control") return "bg-heat";
  if (status === "completed" || status === "pr_created") return "bg-jade";
  if (status === "failed" || status === "cancelled") return "bg-destructive";
  return "bg-muted-foreground/50";
}

function ThreadRow({ run, active }: { run: RunRecord; active: boolean }) {
  const isLive = ACTIVE.includes(run.status);
  return (
    <Link
      to="/runs/$runId"
      params={{ runId: run.id }}
      className={cn(
        "group flex h-8 items-center gap-2 rounded-xl pl-7 pr-2 text-left text-sm",
        "text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
        active && "bg-accent text-foreground",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          statusDotClass(run.status),
          isLive && "animate-pulse",
        )}
      />
      <span className="min-w-0 flex-1 truncate text-xs font-medium">{run.title}</span>
      <span
        className={cn(
          "shrink-0 text-[10px] tracking-tight text-muted-foreground/50",
          active ? "opacity-100" : "opacity-0 group-hover:opacity-100",
        )}
      >
        {formatRelativeTime(run.updatedAt)}
      </span>
    </Link>
  );
}
