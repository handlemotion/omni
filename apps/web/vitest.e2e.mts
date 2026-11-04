import { mergeConfig } from "vitest/config";
import { e2e } from "../../vitest.shared.mts";

// The suites start the Worker from the bundle this setup builds once (apps/worker/e2e/support.ts).
export default mergeConfig(e2e, {
  test: { globalSetup: ["../../apps/worker/e2e/global-setup.ts"] },
});
