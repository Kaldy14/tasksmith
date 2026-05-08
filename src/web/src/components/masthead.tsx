import { Link } from "@tanstack/react-router";
import { Flame, Radio } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ConnectionStatus } from "@/types";

interface MastheadProps {
  connection: ConnectionStatus;
}

const CONNECTION_LABEL: Record<ConnectionStatus, string> = {
  idle: "idle",
  connecting: "connecting",
  online: "live",
  offline: "offline",
};

export function Masthead({ connection }: MastheadProps) {
  return (
    <header className="sticky top-0 z-20 flex h-16 items-center justify-between border-b border-border/60 bg-background/70 px-6 backdrop-blur-md md:px-8">
      <Link to="/" className="group flex items-center gap-2.5">
        <span className="grid h-7 w-7 place-items-center border border-heat/40 bg-zinc-950">
          <Flame className="h-3.5 w-3.5 text-heat" strokeWidth={2.2} />
        </span>
        <span className="text-[0.92rem] font-semibold tracking-tight">tasksmith</span>
      </Link>

      <div
        className={cn(
          "flex h-7 items-center gap-2 border px-2.5 font-mono text-[0.62rem] uppercase tracking-[0.16em]",
          connection === "online" && "border-jade/45 text-jade",
          connection === "connecting" && "border-heat/45 text-heat",
          connection === "offline" && "border-destructive/40 text-destructive",
          connection === "idle" && "border-border/60 text-muted-foreground",
        )}
      >
        <Radio className="h-2.5 w-2.5" />
        {CONNECTION_LABEL[connection]}
      </div>
    </header>
  );
}
