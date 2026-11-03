import { XMarkIcon } from "@heroicons/react/20/solid";
import { IconSearch } from "@/components/icons/sidebar";
import { Button } from "react-aria-components/Button";
import type { InputProps } from "./input";
import {
  SearchField as SearchFieldPrimitive,
  type SearchFieldProps,
} from "react-aria-components/SearchField";
import { twJoin } from "cn";
import { fieldStyles } from "@/components/ui/field";
import { cx } from "@/lib/primitive";
import { Input, InputGroup } from "./input";

export function SearchField({ className, ...props }: SearchFieldProps) {
  return (
    <SearchFieldPrimitive
      data-slot="control"
      aria-label={props["aria-label"] ?? "Search"}
      className={cx(fieldStyles({ className: "group/search-field" }), className)}
      {...props}
    />
  );
}

export function SearchInput(props: InputProps) {
  return (
    <InputGroup className="[--input-gutter-end:--spacing(8)]">
      <IconSearch className="in-disabled:opacity-50" />
      <Input {...props} />
      <Button
        className={twJoin(
          "touch-target grid place-content-center pressed:text-foreground text-muted-foreground hover:text-foreground group-empty/search-field:invisible",
          "px-2",
        )}
      >
        <XMarkIcon className="size-3.5" />
      </Button>
    </InputGroup>
  );
}
