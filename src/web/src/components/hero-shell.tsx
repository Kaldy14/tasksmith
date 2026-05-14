import * as React from "react";
import { cn } from "@/lib/utils";
import { BrandMark } from "./brand-mark";

interface HeroShellProps {
  tagline: string;
  headline: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
}

export function HeroShell({ tagline, headline, children, footer, className }: HeroShellProps) {
  return (
    <div className={cn("mx-auto flex w-full max-w-2xl flex-col px-6 pb-24 pt-20", className)}>
      <div className="flex flex-col items-center gap-4 text-center">
        <BrandMark size="lg" />
        <div className="space-y-1">
          <h1 className="text-display font-medium tracking-tight text-foreground">TaskSmith</h1>
          <p className="text-base text-muted-foreground">{tagline}</p>
        </div>
      </div>
      <h2 className="mt-12 mb-4 text-h2 font-medium text-foreground">{headline}</h2>
      {children}
      {footer ? <div className="mt-10">{footer}</div> : null}
    </div>
  );
}

interface HeroCardProps {
  children: React.ReactNode;
  className?: string;
}

export function HeroCard({ children, className }: HeroCardProps) {
  return (
    <div
      className={cn(
        "rounded-2xl border border-border bg-surface-1 p-1 shadow-[0_1px_0_oklch(1_0_0_/_0.04),0_24px_48px_-24px_oklch(0_0_0_/_0.6)]",
        className,
      )}
    >
      <div className="rounded-[15px] bg-surface-2 p-4">{children}</div>
    </div>
  );
}
