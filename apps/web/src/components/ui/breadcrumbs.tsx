import { ChevronRightIcon } from "@heroicons/react/20/solid";
import { createContext, use } from "react";
import type { BreadcrumbProps, BreadcrumbsProps } from "react-aria-components/Breadcrumbs";
import { Breadcrumb, Breadcrumbs as BreadcrumbsPrimitive } from "react-aria-components/Breadcrumbs";
import type { LinkProps } from "react-aria-components/Link";
import { cn } from "cn";
import { cx } from "@/lib/primitive";
import { Link } from "./link";

export type BreadcrumbsContextProps = {
  separator?: "chevron" | "slash" | boolean;
  /** `lg`: the trail is a page's title, in the title's size. */
  size?: "sm" | "lg";
};
const BreadcrumbsProvider = createContext<BreadcrumbsContextProps>({
  separator: "chevron",
});

/**
 * The places above this one, muted, then this one in the foreground. Each crumb's label cuts with
 * an ellipsis when the trail runs out of room; crumbs marked `shrink-0` keep theirs.
 */
export function Breadcrumbs<T extends object>({
  className,
  size = "sm",
  ...props
}: BreadcrumbsProps<T> & BreadcrumbsContextProps) {
  return (
    <BreadcrumbsProvider value={{ separator: props.separator, size }}>
      <BreadcrumbsPrimitive
        {...props}
        className={cn("flex min-w-0 items-center gap-1.5 overflow-hidden", className)}
      />
    </BreadcrumbsProvider>
  );
}

export interface BreadcrumbsItemProps extends BreadcrumbProps, BreadcrumbsContextProps {}

export function BreadcrumbsItem({
  separator = true,
  className,
  ...props
}: BreadcrumbsItemProps & Partial<Omit<LinkProps, "className">>) {
  const { separator: contextSeparator, size } = use(BreadcrumbsProvider);
  separator = contextSeparator ?? separator;
  const separatorValue = separator === true ? "chevron" : separator;

  return (
    <Breadcrumb
      className={cx(
        cn(
          "flex min-w-0 items-center gap-1.5 text-muted-foreground current:text-foreground",
          size === "lg" ? "text-lg" : "text-sm",
        ),
        className,
      )}
      data-slot="breadcrumb-item"
      {...props}
    >
      {({ isCurrent }) => (
        <>
          <Link
            // The current crumb is a disabled link: it keeps full ink, as the page's own name.
            className="min-w-0 truncate current:opacity-100 has-data-[slot=icon]:inline-flex has-data-[slot=icon]:items-center has-data-[slot=icon]:gap-x-2 *:data-[slot=icon]:size-5 sm:*:data-[slot=icon]:size-4 *:data-[slot=icon]:text-muted-foreground hover:*:data-[slot=icon]:text-foreground"
            {...props}
          />
          {!isCurrent && separator !== false && <Separator separator={separatorValue} />}
        </>
      )}
    </Breadcrumb>
  );
}

function Separator({ separator = "chevron" }: { separator?: BreadcrumbsItemProps["separator"] }) {
  return (
    <span className="*:shrink-0 *:text-muted-foreground *:data-[slot=icon]:size-3.5">
      {separator === "chevron" && <ChevronRightIcon />}
      {separator === "slash" && <span className="text-muted-foreground">/</span>}
    </span>
  );
}

export type { BreadcrumbsProps };
