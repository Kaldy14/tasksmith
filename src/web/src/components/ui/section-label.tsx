import * as React from "react";
import { cn } from "@/lib/utils";

interface SectionLabelProps extends React.HTMLAttributes<HTMLDivElement> {
  trailing?: React.ReactNode;
}

export function SectionLabel({ className, children, trailing, ...props }: SectionLabelProps) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 text-caption font-medium uppercase tracking-caption text-subtle-foreground",
        className,
      )}
      {...props}
    >
      <span>{children}</span>
      {trailing ? <span className="ml-auto flex items-center gap-1">{trailing}</span> : null}
    </div>
  );
}
