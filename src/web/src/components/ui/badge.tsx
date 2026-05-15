import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-caption font-medium transition-colors",
  {
    variants: {
      variant: {
        default: "border-border bg-accent text-muted-foreground",
        working: "border-copper/40 bg-copper/10 text-copper",
        attention: "border-heat/45 bg-heat/12 text-heat",
        running: "border-steel/40 bg-steel/10 text-steel",
        completed: "border-jade/40 bg-jade/10 text-jade",
        failed: "border-destructive/45 bg-destructive/12 text-destructive",
        waiting: "border-heat/45 bg-heat/12 text-heat",
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
