import { XMarkIcon } from "@heroicons/react/20/solid";
import { InputClear } from "@ui-sdk/react/input";
import { IconSearch } from "@/components/icons/sidebar";
import { Input, InputGroup, type InputProps } from "./input";
import { TextField, type TextFieldProps } from "./text-field";

/** A search box: `<SearchField value onChange><SearchInput /></SearchField>`. */
export function SearchField({ className, ...props }: TextFieldProps) {
  return (
    <TextField
      type="search"
      aria-label={props["aria-label"] ?? "Search"}
      className={className}
      {...props}
    />
  );
}

/** The search icon, the input, and a clear button that shows while there's text. */
export function SearchInput(props: InputProps) {
  return (
    <InputGroup className="[--input-gutter-end:--spacing(8)]">
      <IconSearch className="in-disabled:opacity-50" />
      <Input {...props} />
      <InputClear
        aria-label="Clear search"
        className="touch-target grid place-content-center px-2 text-muted-foreground hover:text-foreground active:text-foreground"
      >
        <XMarkIcon className="size-3.5" />
      </InputClear>
    </InputGroup>
  );
}
