import { Link } from "@tanstack/react-router";
import { cn } from "@/lib/utils";
import type { RunStatus } from "@/types";

const STATUS_DOT: Record<RunStatus, string> = {
  queued: "bg-muted-foreground",
  claimed: "bg-copper motion-safe:animate-pulse",
  preparing: "bg-copper motion-safe:animate-pulse",
  running: "bg-copper motion-safe:animate-pulse",
  waiting_for_control: "bg-heat motion-safe:animate-pulse",
  verifying: "bg-copper motion-safe:animate-pulse",
  fixing: "bg-copper motion-safe:animate-pulse",
  reviewing: "bg-copper motion-safe:animate-pulse",
  watching_ci: "bg-copper motion-safe:animate-pulse",
  delivering: "bg-copper motion-safe:animate-pulse",
  creating_pr: "bg-copper motion-safe:animate-pulse",
  pr_created: "bg-jade",
  completed: "bg-jade",
  failed: "bg-destructive",
  cancelled: "bg-destructive",
};

interface RunChipProps {
  runId: string;
  title: string;
  status: RunStatus;
  className?: string;
}

export function RunChip({ runId, title, status, className }: RunChipProps) {
  return (
    <Link
      to="/runs/$runId"
      params={{ runId }}
      className={cn(
        "inline-flex max-w-[28ch] shrink-0 items-center gap-2 rounded-full border border-border bg-surface-1 px-3 py-1.5 text-sm text-foreground transition-colors hover:border-border-strong hover:bg-surface-2",
        className,
      )}
    >
      <span className={cn("size-1.5 shrink-0 rounded-full", STATUS_DOT[status])} aria-hidden />
      <span className="truncate">{title}</span>
    </Link>
  );
}

interface RunChipStripProps {
  runs: Array<{ id: string; title: string; status: RunStatus }>;
  className?: string;
}

export function RunChipStrip({ runs, className }: RunChipStripProps) {
  if (runs.length === 0) return null;
  return (
    <div
      className={cn(
        "flex gap-2 overflow-x-auto pb-2",
        "[mask-image:linear-gradient(to_right,transparent,black_24px,black_calc(100%-24px),transparent)]",
        className,
      )}
    >
      {runs.slice(0, 6).map((run) => (
        <RunChip key={run.id} runId={run.id} title={run.title} status={run.status} />
      ))}
    </div>
  );
}
