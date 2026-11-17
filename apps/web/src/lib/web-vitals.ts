import * as Sentry from "@sentry/browser";
import { onCLS, onINP, onLCP, type Metric } from "web-vitals";

function report(metric: Metric) {
  if (import.meta.env.VITE_SENTRY_DSN) {
    Sentry.metrics.distribution(`web_vitals.${metric.name.toLowerCase()}`, metric.value, {
      ...(metric.name === "CLS" ? {} : { unit: "millisecond" }),
      attributes: { rating: metric.rating },
    });
  }
  if (import.meta.env.DEV) {
    const value =
      metric.name === "CLS" ? metric.value.toFixed(3) : `${Math.round(metric.value)} ms`;
    console.info(`[web-vitals] ${metric.name} ${value} (${metric.rating})`, metric);
  }
}

/** Each metric is reported once, with its final value, when the page is hidden. */
export function reportWebVitals() {
  onLCP(report);
  onINP(report);
  onCLS(report);
}
