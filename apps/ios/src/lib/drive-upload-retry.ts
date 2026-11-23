import * as Network from "expo-network";
import type { UploadNetwork } from "@omni/client";

const isOffline = (state: Network.NetworkState) =>
  state.isConnected === false || state.isInternetReachable === false;

const offline = async () =>
  isOffline(await Network.getNetworkStateAsync().catch(() => ({}) as Network.NetworkState));

async function online(signal: AbortSignal) {
  if (!(await offline())) return;
  await new Promise<void>((resolve, reject) => {
    const subscription = Network.addNetworkStateListener((state) => {
      if (isOffline(state)) return;
      finish();
      resolve();
    });
    const stop = () => {
      finish();
      reject(signal.reason);
    };
    const finish = () => {
      subscription.remove();
      signal.removeEventListener("abort", stop);
    };
    if (signal.aborted) stop();
    else signal.addEventListener("abort", stop, { once: true });
  });
}

/** The phone's network, as `expo-network` tells it. */
export const phoneNetwork: UploadNetwork = { online, offline };
