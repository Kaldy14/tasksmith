import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";

const chipVariants = cva(
  "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-caption uppercase tracking-caption transition-colors [&_svg]:size-3.5 [&_svg]:shrink-0",
  {
    variants: {
      tone: {
        muted: "bg-accent text-muted-foreground",
        jade: "bg-jade/12 text-jade",
        heat: "bg-heat-muted text-heat",
        copper: "bg-copper/12 text-copper",
        steel: "bg-steel/12 text-steel",
        destructive: "bg-destructive/12 text-destructive",
      },
      interactive: {
        true: "cursor-pointer hover:brightness-110",
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
