import { passkeyClient } from "@better-auth/passkey/client";
import { createAuthClient, type BetterAuthClientPlugin } from "better-auth/client";
import {
  magicLinkClient,
  multiSessionClient,
  organizationClient,
} from "better-auth/client/plugins";

export interface AuthOptions<Extra extends BetterAuthClientPlugin[]> {
  /** The Worker's origin; auth lives under `/api/auth`. */
  baseUrl: string;
  /** More client plugins, e.g. `expoClient({ storage: SecureStore, ... })` on iOS. */
  plugins?: Extra;
  /** Replaces the global `fetch`. */
  fetch?: typeof fetch;
}

/**
 * Better Auth's vanilla client with the plugins `@omni/auth` enables on the server: magic link,
 * passkey, organizations (invitations, `setActive`), multi-session (`listDeviceSessions`,
 * `setActive`, `revoke`). Framework-free; `useSession` is a nanostores atom.
 */
export function createAuth<const Extra extends BetterAuthClientPlugin[] = []>(
  options: AuthOptions<Extra>,
) {
  return createAuthClient({
    baseURL: new URL("/api/auth", options.baseUrl).toString(),
    fetchOptions: {
      credentials: "include",
      ...(options.fetch ? { customFetchImpl: options.fetch } : {}),
    },
    plugins: [
      magicLinkClient(),
      passkeyClient(),
      organizationClient(),
      multiSessionClient(),
      ...((options.plugins ?? []) as Extra),
    ],
  });
}

export type AuthClient = ReturnType<typeof createAuth>;
