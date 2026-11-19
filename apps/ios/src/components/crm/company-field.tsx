import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { PressableRow } from "@/components/ui/pressable-row.tsx";
import { Text } from "@/components/ui/text.tsx";
import { TextField } from "@/components/ui/text-field.tsx";
import { api, call } from "@/lib/api.ts";
import { keys } from "@/lib/query-keys.ts";
import { space } from "@/theme/tokens.ts";

export interface CompanyChoice {
  id: string;
  name: string;
}

function useDebounced(value: string, ms: number) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/**
 * A company by name, searched on the server as it is typed (the web's `CompanyPicker`). Picking
 * one fills the field; typing again clears the choice, and emptying it chooses none.
 */
export function CompanyField(props: {
  value: CompanyChoice | null;
  onChange: (company: CompanyChoice | null) => void;
}) {
  const [text, setText] = useState(props.value?.name ?? "");
  const q = useDebounced(text.trim(), 200);
  const searching = !!q && q !== props.value?.name;
  const found = useQuery({
    queryKey: keys.crmCompanySearch(q),
    queryFn: ({ signal }) =>
      call(api.crm.companies.$get({ query: { q, limit: "5" } }, { init: { signal } })),
    enabled: searching,
  });
  const matches = searching ? (found.data?.companies ?? []) : [];
  return (
    <View>
      <TextField
        label="Company"
        placeholder="Company"
        autoCapitalize="words"
        autoCorrect={false}
        value={text}
        onChangeText={(next) => {
          setText(next);
          if (props.value) props.onChange(null);
        }}
      />
      {matches.length ? (
        <View style={styles.matches}>
          {matches.map((company) => (
            <PressableRow
              key={company.id}
              shape="inset"
              onPress={() => {
                setText(company.name);
                props.onChange({ id: company.id, name: company.name });
              }}
            >
              <Text numberOfLines={1}>{company.name}</Text>
            </PressableRow>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  matches: { paddingTop: space(1) },
});
