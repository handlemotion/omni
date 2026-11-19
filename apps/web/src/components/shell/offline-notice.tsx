import { useEffect } from "react";
import { appToast } from "@/components/ui/toast";
import { useConnectivity } from "@/hooks/use-connectivity.ts";
import { retryNow } from "@/lib/connectivity.ts";

const ID = "offline";
const BLIP_GRACE_MS = 1_500;

/**
 * While the API can't be reached: a bar that stays, in the toast stack, with what is queued and a
 * way to check again now. What is cached stays usable underneath; it leaves once the API answers.
 * A blip shorter than `BLIP_GRACE_MS` (one dropped request, a Wi-Fi handover) shows nothing.
 */
export function OfflineNotice() {
  const { online, queued } = useConnectivity();
  useEffect(() => {
    if (online) return;
    const show = () =>
      appToast.prompt("You're offline", {
        id: ID,
        tone: "warning",
        ...(queued > 0 && { description: `${queued} queued` }),
        primary: { label: "Try again", onClick: () => void retryNow() },
      });
    const timer = setTimeout(show, BLIP_GRACE_MS);
    return () => clearTimeout(timer);
  }, [online, queued]);
  useEffect(() => {
    if (online) appToast.dismiss(ID);
  }, [online]);
  return null;
}
