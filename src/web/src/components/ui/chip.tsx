import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";

const chipVariants = cva(
  "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-sm font-medium tracking-tight transition-colors [&_svg]:size-3.5 [&_svg]:shrink-0",
  {
    variants: {
      tone: {
        muted: "border-border bg-accent text-muted-foreground",
        jade: "border-jade/30 bg-jade/15 text-jade",
        heat: "border-heat/35 bg-heat-muted text-heat",
        copper: "border-copper/30 bg-copper/15 text-copper",
        steel: "border-steel/30 bg-steel/15 text-steel",
        destructive: "border-destructive/35 bg-destructive/15 text-destructive",
      },
      interactive: {
        true: "cursor-pointer hover:border-border-strong hover:brightness-110",
        false: "",
      },
    },
    defaultVariants: { tone: "muted", interactive: false },
  },
);

interface ChipBaseProps extends VariantProps<typeof chipVariants> {
  icon?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}

type ChipLinkProps = ChipBaseProps & {
  href: string;
  external?: boolean;
} & Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, keyof ChipBaseProps | "href">;

type ChipSpanProps = ChipBaseProps & { href?: undefined } & Omit<
    React.HTMLAttributes<HTMLSpanElement>,
    keyof ChipBaseProps
  >;

export type ChipProps = ChipLinkProps | ChipSpanProps;

export function Chip(props: ChipProps) {
  const { tone, icon, className, children } = props;

  if ("href" in props && props.href) {
    const { href, external, interactive, ...rest } = props;
    return (
      <a
        href={href}
        target={external ? "_blank" : undefined}
        rel={external ? "noopener noreferrer" : undefined}
        className={cn(chipVariants({ tone, interactive: interactive ?? true }), className)}
        {...rest}
      >
        {icon}
        <span>{children}</span>
        {external ? <ExternalLink aria-hidden /> : null}
      </a>
    );
  }

  const { interactive, ...rest } = props as ChipSpanProps;
  return (
    <span className={cn(chipVariants({ tone, interactive }), className)} {...rest}>
      {icon}
      <span>{children}</span>
    </span>
  );
}
