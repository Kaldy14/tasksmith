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

type StatusVariant = "running" | "completed" | "failed" | "waiting" | "queued";

const STATUS_TO_VARIANT = {
  queued: "queued",
  claimed: "running",
  preparing: "running",
  running: "running",
  waiting_for_control: "waiting",
  verifying: "running",
  fixing: "running",
  reviewing: "running",
  watching_ci: "running",
  delivering: "running",
  creating_pr: "running",
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
  const isActive = variant === "running" || variant === "waiting";
  return (
    <Badge variant={variant} className={className}>
      <span
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          variant === "running" && "bg-steel",
          variant === "completed" && "bg-jade",
          variant === "failed" && "bg-destructive",
          variant === "waiting" && "bg-heat",
          variant === "queued" && "bg-muted-foreground",
          isActive && "animate-pulse",
        )}
      />
      {STATUS_LABEL[status]}
    </Badge>
  );
}
