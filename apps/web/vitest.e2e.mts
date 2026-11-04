import { mergeConfig } from "vitest/config";
import { e2e } from "../../vitest.shared.mts";

// The suites start the Worker from the bundle this setup builds once (apps/worker/e2e/support.ts).
// Files stay serial: under parallel load, connectivity's restart test finds the open thread not
// refetched after the socket reconnects (an app-side timing bug, not a test-isolation one).
export default mergeConfig(e2e, {
  test: { globalSetup: ["../../apps/worker/e2e/global-setup.ts"], fileParallelism: false },
});
