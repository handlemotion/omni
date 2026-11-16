// The bundled local shell (docs/spec/desktop.md, "The shell"). It decides which Omni server the
// window shows, then leaves: the stored choice, else the build's default, else the server
// picker. It never calls `/api`.
//
// Scaffold: only the build's default is wired. The stored choice, the picker and the offline
// screen are the shell layer's work.
const origin = import.meta.env.OMNI_DESKTOP_ORIGIN;

if (typeof origin === "string" && origin.length > 0) {
  window.location.replace(new URL(origin).origin);
}
