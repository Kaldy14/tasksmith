import { Flame } from "lucide-react";
import { cn } from "@/lib/utils";

type BrandMarkSize = "sm" | "md" | "lg";

interface BrandMarkProps {
  size?: BrandMarkSize;
  className?: string;
}

const SIZE_CLASS: Record<BrandMarkSize, string> = {
  sm: "size-7 rounded-md",
  md: "size-9 rounded-lg",
  lg: "size-12 rounded-xl",
};

const ICON_CLASS: Record<BrandMarkSize, string> = {
  sm: "size-3.5",
  md: "size-4",
  lg: "size-6",
};

export function BrandMark({ size = "md", className }: BrandMarkProps) {
  return (
    <span
      className={cn(
        "inline-grid place-items-center bg-heat-muted text-heat shadow-[0_0_0_1px_var(--heat-glow)]",
        SIZE_CLASS[size],
        className,
      )}
      aria-hidden
    >
      <Flame className={ICON_CLASS[size]} strokeWidth={1.75} />
    </span>
  );
}
