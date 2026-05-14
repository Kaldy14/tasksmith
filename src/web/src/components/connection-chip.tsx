import { Loader2, PanelRight, Wifi, WifiOff } from "lucide-react";
import { cn } from "@/lib/utils";

export type ConnectionState = "idle" | "connecting" | "connected" | "disconnected";

const STATE: Record<
  ConnectionState,
  { label: string; tone: string; icon: typeof PanelRight; pulse: boolean }
> = {
  idle: { label: "Idle", tone: "text-subtle-foreground", icon: PanelRight, pulse: false },
  connecting: {
    label: "Connecting",
    tone: "text-copper",
    icon: Loader2,
    pulse: true,
  },
  connected: { label: "Live", tone: "text-jade", icon: Wifi, pulse: false },
  disconnected: {
    label: "Offline",
    tone: "text-destructive",
    icon: WifiOff,
    pulse: false,
  },
};

interface ConnectionChipProps {
  state: ConnectionState;
  className?: string;
}

export function ConnectionChip({ state, className }: ConnectionChipProps) {
  const { label, tone, icon: Icon, pulse } = STATE[state];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 text-caption uppercase tracking-caption",
        tone,
        className,
      )}
    >
      <Icon className={cn("size-3.5", pulse && "motion-safe:animate-spin")} aria-hidden />
      <span>{label}</span>
    </span>
  );
}
