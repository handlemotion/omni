import { mergeConfig } from "vitest/config";
import { e2e } from "../../vitest.shared.mts";

export default mergeConfig(e2e, {
  test: { globalSetup: ["../../apps/worker/e2e/global-setup.ts"] },
});
