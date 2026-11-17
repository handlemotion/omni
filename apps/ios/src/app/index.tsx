import { Redirect } from "expo-router";

/** The app opens on Mail; a sign-in link lands here too. */
export default function Index() {
  return <Redirect href="/mail" />;
}
