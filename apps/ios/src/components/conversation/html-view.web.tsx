/**
 * Expo's web target (screenshots and checks only): the same HTML in a sandboxed iframe with
 * scripts off, as the web app shows it.
 */
export function HtmlView({ html }: { html: string; baseUrl: string }) {
  return (
    <iframe
      title="Full message"
      sandbox="allow-popups allow-popups-to-escape-sandbox"
      srcDoc={html}
      style={{ border: 0, flex: 1, width: "100%", height: "100%" }}
    />
  );
}
