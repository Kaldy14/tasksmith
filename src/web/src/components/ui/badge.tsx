import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[0.66rem] font-medium uppercase tracking-[0.12em] transition-colors",
  {
    variants: {
      variant: {
        default: "border-border bg-accent text-muted-foreground",
        running: "border-primary/35 bg-primary/10 text-primary",
        completed: "border-jade/35 bg-jade/10 text-jade",
        failed: "border-destructive/45 bg-destructive/10 text-destructive",
        waiting: "border-heat/45 bg-heat/10 text-heat",
        queued: "border-border bg-accent text-muted-foreground",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { badgeVariants };
