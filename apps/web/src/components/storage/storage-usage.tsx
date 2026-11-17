import { Skeleton } from "skullet/react";
import { SettingsGroup, SettingsSection } from "@/components/settings/kit/settings-layout";
import { SettingsMeterRow } from "@/components/settings/kit/settings-meter-row";
import { SettingsValueRow } from "@/components/settings/kit/settings-value-row";
import { useStorageUsage } from "@/hooks/use-storage.ts";
import { formatBytes } from "@/lib/storage.ts";

const SAMPLE = {
  usedBytes: 1_200_000_000,
  reservedBytes: 0,
  allowanceBytes: null,
  limitBytes: 5 * 1024 ** 3,
  overage: null,
  uploadsBlocked: null,
};

export function StorageUsageSection() {
  const usage = useStorageUsage();
  return (
    <SettingsSection title="Storage">
      <Skeleton
        id="settings-billing-storage"
        data={usage.data}
        sample={SAMPLE}
        label="Loading storage"
      >
        {(state) => {
          const cap = state.limitBytes ?? state.allowanceBytes;
          return (
            <SettingsGroup>
              {cap === null ? (
                <SettingsValueRow label="Drive" value={formatBytes(state.usedBytes)} />
              ) : (
                <SettingsMeterRow
                  label="Drive"
                  amount={`${formatBytes(state.usedBytes)} of ${formatBytes(cap)}`}
                  value={state.usedBytes}
                  max={cap}
                  warn={state.usedBytes >= cap * 0.9}
                />
              )}
            </SettingsGroup>
          );
        }}
      </Skeleton>
    </SettingsSection>
  );
}
