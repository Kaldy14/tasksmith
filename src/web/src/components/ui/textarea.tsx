import * as React from "react";
import { cn } from "@/lib/utils";

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => {
  return (
    <textarea
      ref={ref}
      className={cn(
        "flex min-h-[120px] w-full resize-y rounded-lg border border-border bg-surface-1 px-3.5 py-3 text-base leading-6 text-foreground transition-colors",
        "placeholder:text-subtle-foreground",
        "outline-none focus-visible:border-heat/60 focus-visible:ring-2 focus-visible:ring-heat/25",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
});
Textarea.displayName = "Textarea";
