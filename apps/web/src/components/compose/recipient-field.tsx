import { use, useEffect, useRef, useState } from "react";
import {
  ComboBox as ComboBoxPrimitive,
  ComboBoxStateContext,
} from "react-aria-components/ComboBox";
import {
  ComboBoxContent,
  ComboBoxDescription,
  ComboBoxItem,
  ComboBoxLabel,
} from "@/components/ui/combo-box";
import { AriaInput } from "@/components/ui/aria-input";
import { Tag, TagGroup, TagList } from "@/components/ui/tag-group";
import { useCustomerSearch, type CustomerMatch } from "@/hooks/use-compose.ts";

/** Loose on purpose: the Worker validates; this only decides when typing becomes a chip. */
const ADDRESS = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

/** Every address in pasted or typed text, in order, without repeats. */
export function parseAddresses(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).map((a) => a.replace(/^<|>$/g, "").trim()))].filter(
    (a) => ADDRESS.test(a),
  );
}

/**
 * One recipient line: a label, the addresses as removable chips, and a field that suggests
 * customers as you type. Enter, comma, space or a paste turns typed addresses into chips;
 * Backspace in an empty field takes the last one back.
 */
export function RecipientField(props: {
  label: string;
  value: string[];
  onChange: (next: string[]) => void;
  autoFocus?: boolean;
  /** Shown at the end of the line (the Cc/Bcc toggles). */
  end?: React.ReactNode;
}) {
  const { value, onChange } = props;
  const [text, setText] = useState("");
  const { customers } = useCustomerSearch(text);
  const input = useRef<HTMLInputElement>(null);
  const suggestions = customers.filter((c) => !value.includes(c.address));

  const add = (addresses: string[]) => {
    const fresh = addresses.filter((a) => !value.some((v) => v.toLowerCase() === a.toLowerCase()));
    if (fresh.length) onChange([...value, ...fresh]);
  };
  const commit = () => {
    const found = parseAddresses(text);
    if (!found.length) return false;
    add(found);
    setText("");
    return true;
  };

  return (
    // One of the composer's rows: its height set by `ComposerFrame`, its divider the card's full width.
    // The label (From, To, Cc, Bcc) keeps the 32px column the labels line up in.
    <div className="flex min-h-(--composer-row) items-center gap-2.5 border-b px-3 py-1">
      <span className="flex w-8 shrink-0 text-sm text-muted-foreground">{props.label}</span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
        {value.length > 0 && (
          <TagGroup
            aria-label={props.label}
            onRemove={(keys) => onChange(value.filter((a) => !keys.has(a)))}
          >
            <TagList items={value.map((address) => ({ address }))}>
              {(item) => <Tag id={item.address}>{item.address}</Tag>}
            </TagList>
          </TagGroup>
        )}
        <ComboBoxPrimitive<CustomerMatch>
          aria-label={props.label}
          className="min-w-32 flex-1"
          items={suggestions}
          inputValue={text}
          onInputChange={setText}
          allowsCustomValue
          allowsEmptyCollection={false}
          menuTrigger="input"
          selectedKey={null}
          onSelectionChange={(key) => {
            const match = suggestions.find((c) => c.id === key);
            if (match) {
              add([match.address]);
              setText("");
            }
          }}
        >
          <AriaInput
            ref={input}
            plain
            size="sm"
            // With no pills yet, typing starts where a pill's text would (8px in), like From's.
            className={value.length ? "" : "ps-2"}
            autoFocus={props.autoFocus}
            onKeyDown={(event) => {
              if ([",", ";", " "].includes(event.key) || (event.key === "Enter" && text)) {
                if (commit()) event.preventDefault();
              } else if (event.key === "Backspace" && !text && value.length) {
                onChange(value.slice(0, -1));
              }
            }}
            onBlur={() => commit()}
            onPaste={(event) => {
              const found = parseAddresses(event.clipboardData.getData("text"));
              if (found.length > 1) {
                event.preventDefault();
                add(found);
              }
            }}
          />
          <OpenWhenSuggested count={suggestions.length} />
          <ComboBoxContent items={suggestions} popover={{ placement: "bottom start" }}>
            {(customer) => (
              <ComboBoxItem id={customer.id} textValue={customer.address}>
                <ComboBoxLabel>{customer.name || customer.address}</ComboBoxLabel>
                {customer.name && <ComboBoxDescription>{customer.address}</ComboBoxDescription>}
              </ComboBoxItem>
            )}
          </ComboBoxContent>
        </ComboBoxPrimitive>
      </div>
      {props.end}
    </div>
  );
}

/**
 * Suggestions come from the server after the keystroke, when the combo box has already decided
 * there was nothing to open. This opens it once they arrive, while the field still has focus.
 */
function OpenWhenSuggested({ count }: { count: number }) {
  const state = use(ComboBoxStateContext);
  useEffect(() => {
    if (state && count > 0 && state.isFocused && !state.isOpen) state.open(null, "input");
  }, [count, state]);
  return null;
}
