import Constants from "expo-constants";
import { z } from "zod";

// Validated once at startup (see `.env.example`). Expo inlines `EXPO_PUBLIC_*` at build time, so
// each is read by its literal name.
const schema = z.object({
  apiUrl: z.url(),
  scheme: z.string().min(1),
});

export const config = schema.parse({
  apiUrl: process.env.EXPO_PUBLIC_OMNI_API_URL,
  scheme: Constants.expoConfig?.scheme,
});
