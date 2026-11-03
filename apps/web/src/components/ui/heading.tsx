import { cn } from "cn";

export type HeadingType = { level?: 1 | 2 | 3 | 4 } & React.ComponentPropsWithoutRef<
  "h1" | "h2" | "h3" | "h4"
>;

export interface HeadingProps extends HeadingType {
  className?: string | undefined;
}

export function Heading({ className, level = 1, ...props }: HeadingProps) {
  const Element: `h${typeof level}` = `h${level}`;
  return <Element className={cn("text-lg text-foreground", className)} {...props} />;
}
