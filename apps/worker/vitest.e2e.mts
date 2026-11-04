import { mergeConfig } from "vitest/config";
import { e2e } from "../../vitest.shared.mts";

export default mergeConfig(e2e, {
  resolve: {
    alias: {
      "cloudflare:workers": new URL("./e2e/cloudflare-workers.ts", import.meta.url).pathname,
    },
  },
});
