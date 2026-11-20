import { Label } from "@/components/ui/field";
import {
  MultipleSelect,
  MultipleSelectContent,
  MultipleSelectItem,
} from "@/components/ui/multiple-select";
import { useMemberNames } from "./task-dialog.tsx";

/** Who on the workspace a contract involves; a freelancer on it sees it and its files. */
export function ContractPeopleField(props: {
  value: string[];
  onChange: (memberIds: string[]) => void;
  isDisabled?: boolean;
}) {
  const people = useMemberNames();
  return (
    <MultipleSelect
      aria-label="People involved"
      placeholder="Nobody"
      value={props.value}
      isDisabled={props.isDisabled}
      onChange={(keys) => props.onChange(keys.map(String))}
    >
      <Label>People involved</Label>
      <MultipleSelectContent items={people}>
        {(person) => (
          <MultipleSelectItem id={person.id} textValue={person.name}>
            {person.name}
          </MultipleSelectItem>
        )}
      </MultipleSelectContent>
    </MultipleSelect>
  );
}
