import { useMemo, useState } from "react";
import { Link, useParams } from "@tanstack/react-router";
import {
  ArrowRight,
  ChevronDown,
  ChevronRight,
  Folder,
  LogOut,
  Plus,
  Settings,
} from "lucide-react";
import { authClient } from "@/auth-client";
import { BrandMark } from "@/components/brand-mark";
import { ConnectionChip, type ConnectionState } from "@/components/connection-chip";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SectionLabel } from "@/components/ui/section-label";
import { cn, formatRelativeTime } from "@/lib/utils";
import type { ConnectionStatus, RunRecord, RunStatus } from "@/types";

interface ProjectRailProps {
  runs: RunRecord[];
  loading: boolean;
  connection: ConnectionStatus;
  authEnabled: boolean;
}

interface ProjectGroup {
  key: string;
  threads: RunRecord[];
  liveCount: number;
}

const ACTIVE: RunStatus[] = [
  "claimed",
  "preparing",
  "running",
  "waiting_for_control",
  "verifying",
  "fixing",
  "reviewing",
  "watching_ci",
  "delivering",
  "creating_pr",
];

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
      threads: [...threads].sort((a, b) => {
        const aLive = ACTIVE.includes(a.status);
        const bLive = ACTIVE.includes(b.status);
        if (aLive !== bLive) return aLive ? -1 : 1;
        return (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0);
      }),
      liveCount: threads.filter((thread) => ACTIVE.includes(thread.status)).length,
    }))
    .sort((a, b) => {
      if (a.liveCount !== b.liveCount) return b.liveCount - a.liveCount;
      const aMax = Math.max(...a.threads.map((thread) => Date.parse(thread.updatedAt) || 0));
      const bMax = Math.max(...b.threads.map((thread) => Date.parse(thread.updatedAt) || 0));
      return bMax - aMax;
    });
}

export function ProjectRail({ runs, loading, connection, authEnabled }: ProjectRailProps) {
  const params = useParams({ strict: false }) as { runId?: string };
  const selected = params.runId;
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const groups = useMemo(() => groupByProject(runs), [runs]);

  function toggle(key: string): void {
    setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  return (
    <aside className="flex w-[272px] shrink-0 flex-col border-r border-border bg-surface-1 text-foreground">
      <div className="flex h-14 shrink-0 items-center px-3">
        <Link
          to="/"
          className="group flex min-w-0 items-center gap-2.5 rounded-lg px-1.5 py-1 text-sm font-semibold tracking-tight text-foreground transition-colors hover:bg-accent"
        >
          <BrandMark size="sm" />
          <span className="truncate">TaskSmith</span>
        </Link>
      </div>

      <div className="px-3 pb-2 pt-4">
        <SectionLabel
          trailing={
            <Button asChild variant="ghost" size="icon" className="size-7">
              <Link to="/" aria-label="Start a new run">
                <Plus className="size-3.5" />
              </Link>
            </Button>
          }
        >
          Projects
        </SectionLabel>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="px-2 pb-3">
          {loading && groups.length === 0 ? (
            <LoadingRows />
          ) : groups.length === 0 ? (
            <Link
              to="/"
              className="mx-1 flex items-center gap-1.5 rounded-lg px-2 py-3 text-sm text-subtle-foreground transition-colors hover:bg-accent hover:text-heat"
            >
              <span>No threads yet — start one above.</span>
              <ArrowRight className="size-3.5" />
            </Link>
          ) : (
            groups.map((group) => {
              const isCollapsed = collapsed[group.key] ?? false;
              return (
                <div key={group.key} className="mb-2">
                  <button
                    type="button"
                    onClick={() => toggle(group.key)}
                    className={cn(
                      "group flex h-9 w-full items-center gap-1.5 rounded-lg px-2 text-left text-sm",
                      "text-foreground/95 transition-colors hover:bg-accent",
                    )}
                  >
                    {isCollapsed ? (
                      <ChevronRight className="size-3.5 text-subtle-foreground" />
                    ) : (
                      <ChevronDown className="size-3.5 text-subtle-foreground" />
                    )}
                    <Folder className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate font-semibold tracking-tight">{group.key}</span>
                    <span
                      className={cn(
                        "ml-auto inline-flex min-w-5 items-center justify-center rounded-md px-1.5 py-0.5 text-caption font-medium",
                        group.liveCount > 0
                          ? "bg-heat-muted text-heat"
                          : "bg-accent text-subtle-foreground",
                      )}
                    >
                      {group.liveCount > 0 ? group.liveCount : group.threads.length}
                    </span>
                  </button>
                  {!isCollapsed ? (
                    <div className="mt-1 space-y-0.5">
                      {group.threads.map((run) => (
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

      <footer className="shrink-0 border-t border-border">
        {authEnabled ? (
          <div className="border-b border-border px-3 py-3">
            <SessionSummary />
          </div>
        ) : null}
        <div className="border-b border-border px-3 py-2">
          <Link
            to="/config"
            className="flex h-9 items-center gap-2 rounded-lg px-2.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <Settings className="size-3.5" />
            Project config
          </Link>
        </div>
        <div className="px-3 py-3">
          <ConnectionChip state={connectionState(connection)} />
        </div>
      </footer>
    </aside>
  );
}

function LoadingRows() {
  return (
    <div className="space-y-2 px-1 py-2" aria-label="Loading runs">
      {Array.from({ length: 3 }, (_, index) => (
        <div key={index} className="h-9 rounded-lg bg-accent motion-safe:animate-pulse" />
      ))}
    </div>
  );
}

function SessionSummary() {
  const session = authClient.useSession();
  if (!session.data?.user) return null;
  return (
    <div className="flex items-center gap-2 rounded-lg bg-accent px-2.5 py-2 text-sm text-muted-foreground">
      <span className="min-w-0 flex-1 truncate">{session.data.user.email}</span>
      <button
        type="button"
        className="grid size-7 place-items-center rounded-md transition-colors hover:bg-background hover:text-foreground"
        aria-label="Sign out"
        onClick={() => {
          void authClient.signOut({
            fetchOptions: {
              onSuccess: () => {
                window.location.href = "/login";
              },
            },
          });
        }}
      >
        <LogOut className="size-3.5" />
      </button>
    </div>
  );
}

function statusDotClass(status: RunStatus): string {
  if (status === "waiting_for_control") return "bg-heat";
  if (ACTIVE.includes(status)) return "bg-copper";
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
        "group relative flex h-9 items-center gap-2 rounded-lg pl-7 pr-2.5 text-left text-sm",
        "text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
        active &&
          "bg-surface-2 text-foreground before:absolute before:bottom-1.5 before:left-0 before:top-1.5 before:w-[2px] before:rounded-full before:bg-heat",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          statusDotClass(run.status),
          isLive && "motion-safe:animate-pulse",
        )}
      />
      <span className="min-w-0 flex-1 truncate font-medium">{run.title}</span>
      <span className="shrink-0 text-caption text-subtle-foreground">
        {formatRelativeTime(run.updatedAt)}
      </span>
    </Link>
  );
}

function connectionState(status: ConnectionStatus): ConnectionState {
  if (status === "connecting") return "connecting";
  if (status === "online") return "connected";
  if (status === "offline") return "disconnected";
  return "idle";
}
