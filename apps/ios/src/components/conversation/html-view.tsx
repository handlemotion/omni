import { Linking } from "react-native";
import { WebView } from "react-native-webview";

/**
 * A message's sanitized HTML in a WebView with JavaScript off (spec: Threading and rendering).
 * Nothing navigates inside it: a tapped link opens in the browser.
 */
export function HtmlView({ html, baseUrl }: { html: string; baseUrl: string }) {
  return (
    <WebView
      source={{ html, baseUrl }}
      javaScriptEnabled={false}
      originWhitelist={["*"]}
      setSupportMultipleWindows={false}
      allowsLinkPreview={false}
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
