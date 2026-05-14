import * as React from "react";
import { cn } from "@/lib/utils";

interface PageHeaderProps {
  primary: React.ReactNode;
  secondary?: React.ReactNode;
  className?: string;
}

export function PageHeader({ primary, secondary, className }: PageHeaderProps) {
  return (
    <div className={cn("flex flex-col", className)}>
      <div className="flex h-14 items-center gap-3 border-b border-border bg-surface-1 px-6">
        {primary}
      </div>
      {secondary ? (
        <div className="flex h-10 items-center gap-2 border-b border-border bg-background px-6">
          {secondary}
        </div>
      ) : null}
    </div>
  );
}

interface PageTitleProps {
  title: string;
  subtitle?: string;
  className?: string;
}

export function PageTitle({ title, subtitle, className }: PageTitleProps) {
  return (
    <div className={cn("min-w-0 flex-1", className)}>
      <h1 className="truncate text-h1 font-medium text-foreground">{title}</h1>
      {subtitle ? (
        <p className="truncate text-sm text-muted-foreground">{subtitle}</p>
      ) : null}
    </div>
  );
}
