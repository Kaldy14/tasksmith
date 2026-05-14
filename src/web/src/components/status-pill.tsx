import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { RunStatus } from "@/types";

const STATUS_LABEL: Record<RunStatus, string> = {
  queued: "queued",
  claimed: "claimed",
  preparing: "preparing",
  running: "running",
  waiting_for_control: "waiting",
  verifying: "verifying",
  fixing: "fixing",
  reviewing: "reviewing",
  watching_ci: "watching CI",
  delivering: "delivering",
  creating_pr: "creating PR",
  pr_created: "PR created",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
};

type StatusVariant = "working" | "attention" | "completed" | "failed" | "queued";

const STATUS_TO_VARIANT = {
  queued: "queued",
  claimed: "working",
  preparing: "working",
  running: "working",
  waiting_for_control: "attention",
  verifying: "working",
  fixing: "working",
  reviewing: "working",
  watching_ci: "working",
  delivering: "working",
  creating_pr: "working",
  pr_created: "completed",
  completed: "completed",
  failed: "failed",
  cancelled: "failed",
} as const satisfies Readonly<Record<RunStatus, StatusVariant>>;

function variantFor(status: RunStatus): StatusVariant {
  return STATUS_TO_VARIANT[status];
}

interface StatusPillProps {
  status: RunStatus;
  className?: string;
}

export function StatusPill({ status, className }: StatusPillProps) {
  const variant = variantFor(status);
  const isLive = variant === "working" || variant === "attention";
  return (
    <Badge variant={variant} className={className}>
      <span
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          variant === "working" && "bg-copper",
          variant === "attention" && "bg-heat",
          variant === "completed" && "bg-jade",
          variant === "failed" && "bg-destructive",
          variant === "queued" && "bg-muted-foreground",
          isLive && "motion-safe:animate-pulse",
        )}
      />
      {STATUS_LABEL[status]}
    </Badge>
  );
}
