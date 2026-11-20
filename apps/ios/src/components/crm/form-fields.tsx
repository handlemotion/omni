import DateTimePicker from "@react-native-community/datetimepicker";
import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { IconCalendar, IconCheck, IconNoOwner, IconUserRound, IconX } from "@/components/icons.ts";
import { MenuRow } from "@/components/shell/menu-row.tsx";
import { Avatar } from "@/components/ui/avatar.tsx";
import { TextField } from "@/components/ui/text-field.tsx";
import { dayText } from "@/lib/crm.ts";
import { useMemberNames } from "@/lib/crm-timeline.ts";
import { colors, iconSize, space } from "@/theme/tokens.ts";

const check = <IconCheck size={iconSize.md} color={colors.foreground} />;

/**
 * Who owns a record, in a form: the owner's name, opening the workspace's members under it
 * (and No owner) to pick from.
 */
export function OwnerField(props: {
  value: string | null;
  onChange: (ownerMemberId: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const members = [...(useMemberNames().data ?? [])];
  const name = members.find(([id]) => id === props.value)?.[1];
  const pick = (ownerMemberId: string | null) => {
    props.onChange(ownerMemberId);
    setOpen(false);
  };
  return (
    <View>
      <MenuRow
        icon={IconUserRound}
        muted
        label="Owner"
        detail={name ?? "No owner"}
        chevron
        onPress={() => setOpen(!open)}
      />
      {open ? (
        <>
          <MenuRow
            icon={IconNoOwner}
            muted
            label="No owner"
            trailing={props.value === null ? check : undefined}
            onPress={() => pick(null)}
          />
          {members.map(([id, member]) => (
            <MenuRow
              key={id}
              lead={<Avatar name={member} size={iconSize.menu} />}
              label={member}
              trailing={props.value === id ? check : undefined}
              onPress={() => pick(id)}
            />
          ))}
        </>
      ) : null}
    </View>
  );
}

/** A deal's value and the currency it is in (ISO 4217), side by side. */
export function ValueField(props: {
  value: string;
  onValue: (text: string) => void;
  currency: string;
  onCurrency: (code: string) => void;
}) {
  return (
    <View style={styles.value}>
      <TextField
        label="Value"
        placeholder="Value"
        keyboardType="decimal-pad"
        value={props.value}
        onChangeText={props.onValue}
        containerStyle={styles.amount}
      />
      <TextField
        label="Currency"
        placeholder="USD"
        autoCapitalize="characters"
        autoCorrect={false}
        maxLength={3}
        value={props.currency}
        onChangeText={(text) => props.onCurrency(text.toUpperCase())}
        containerStyle={styles.currency}
      />
    </View>
  );
}

const pad = (n: number) => String(n).padStart(2, "0");
export const toDay = (date: Date) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
export const fromDay = (day: string | null) => {
  if (!day) return new Date();
  const [year = 0, month = 1, date = 1] = day.split("-").map(Number);
  return new Date(year, month - 1, date);
};

/**
 * When a deal is expected to close (`YYYY-MM-DD`), in a form: the day, opening the system's
 * calendar under it, and a way to clear it.
 */
export function CloseDateField(props: {
  value: string | null;
  onChange: (day: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <View>
      <MenuRow
        icon={IconCalendar}
        muted
        label="Expected close"
        detail={dayText(props.value) ?? "None"}
        chevron
        onPress={() => setOpen(!open)}
      />
      {open ? (
        <>
          <DateTimePicker
            value={fromDay(props.value)}
            mode="date"
            display="inline"
            accentColor={colors.primary}
            onValueChange={(_event, date) => props.onChange(toDay(date))}
          />
          {props.value ? (
            <MenuRow
              icon={IconX}
              muted
              label="Clear date"
              onPress={() => {
                props.onChange(null);
                setOpen(false);
              }}
            />
          ) : null}
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  value: { flexDirection: "row", gap: space(3) },
  amount: { flex: 1 },
  currency: { width: space(24) },
});
