import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { RunStatus } from "@/types";

const STATUS_LABEL: Record<RunStatus, string> = {
  queued: "queued",
  preparing: "preparing",
  running: "running",
  waiting_for_control: "waiting",
  verifying: "verifying",
  fixing: "fixing",
  reviewing: "reviewing",
  delivering: "delivering",
  creating_pr: "creating PR",
  pr_created: "PR created",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
};

function variantFor(status: RunStatus): "running" | "completed" | "failed" | "waiting" | "queued" {
  if (status === "running" || status === "preparing" || status === "verifying" || status === "fixing" || status === "reviewing" || status === "delivering" || status === "creating_pr") return "running";
  if (status === "completed" || status === "pr_created") return "completed";
  if (status === "failed" || status === "cancelled") return "failed";
  if (status === "waiting_for_control") return "waiting";
  return "queued";
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
