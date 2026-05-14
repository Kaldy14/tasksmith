import * as React from "react";
import { cn } from "@/lib/utils";

export function Kbd({ className, children, ...props }: React.HTMLAttributes<HTMLElement>) {
  return (
    <kbd
      className={cn(
        "inline-flex items-center gap-1 rounded-md border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-mono-xs tracking-tight text-subtle-foreground",
        className,
      )}
      {...props}
    >
      {children}
    </kbd>
  );
}
