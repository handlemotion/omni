import { useEffect, useMemo, useState } from "react";
import { Linking } from "react-native";
import { WebView } from "react-native-webview";
import { auth } from "@/lib/api.ts";
import { messageDocument } from "@/lib/message-html.ts";
import { colors } from "@/theme/tokens.ts";

const MAX_REFITS = 12;

const INITIAL_HEIGHT = 160;

const fitScript = (cookie: string, secure: boolean) => `(function () {
  ${JSON.stringify(cookie)}.split("; ").forEach(function (pair) {
    if (pair) document.cookie = pair + "; path=/" + (${secure} ? "; secure" : "");
  });
  var refits = 0;
  function shrink() {
    var body = document.body;
    if (!body) return;
    body.style.zoom = "";
    var wide = body.scrollWidth, room = body.clientWidth;
    if (wide > room + 1) body.style.zoom = String(room / wide);
  }
  function report() {
    if (++refits > ${MAX_REFITS}) return;
    var body = document.body, root = getComputedStyle(document.documentElement);
    var zoom = Number(body.style.zoom) || 1;
    var edges = parseFloat(root.paddingTop) + parseFloat(root.paddingBottom);
    window.ReactNativeWebView.postMessage(String(Math.ceil(body.offsetHeight * zoom + edges)));
  }
  function start() {
    shrink();
    report();
    if (window.ResizeObserver) new ResizeObserver(report).observe(document.body);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
  window.addEventListener("load", function () {
    refits = 0;
    shrink();
    report();
  });
})(); true;`;

/**
 * A message's sanitized HTML, inline in the conversation (spec: Threading and rendering), as the
 * web's frame shows it. It grows to fit its content and never scrolls on its own; nothing
 * navigates inside it: a tapped link opens in the browser. A script of the app's own (the
 * sender's are stripped by the Worker and refused by the CSP) hands it the session, so its images
 * load, shrinks a layout wider than the screen to fit, and reports its height. Its cookies live
 * only as long as it.
 */
export function HtmlView({ html, baseUrl }: { html: string; baseUrl: string }) {
  const [height, setHeight] = useState(INITIAL_HEIGHT);
  const cookie = useSessionCookie();
  const source = useMemo(() => ({ html: messageDocument(html), baseUrl }), [html, baseUrl]);
  if (cookie === null) return null;
  return (
    <WebView
      source={source}
      style={{ flex: 0, height, backgroundColor: colors.background }}
      containerStyle={{ flex: 0, height }}
      injectedJavaScriptBeforeContentLoaded={fitScript(cookie, baseUrl.startsWith("https:"))}
      onMessage={(event) => {
        const next = Number(event.nativeEvent.data);
        if (next > 0) setHeight(next);
      }}
      incognito
      scrollEnabled={false}
      bounces={false}
      originWhitelist={["*"]}
      setSupportMultipleWindows={false}
      allowsLinkPreview={false}
      dataDetectorTypes="none"
      onShouldStartLoadWithRequest={(request) => {
        if (request.navigationType === "click") {
          void Linking.openURL(request.url);
          return false;
        }
        return request.url === "about:blank" || request.url.startsWith(baseUrl);
      }}
    />
  );
}

function useSessionCookie() {
  const [cookie, setCookie] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void auth.getCookie().then((value) => live && setCookie(value ?? ""));
    return () => {
      live = false;
    };
  }, []);
  return cookie;
}
