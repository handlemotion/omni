// Runs on Node and on workerd (`nodejs_compat`): parsing and threading only. Reply stripping
// and HTML sanitizing need Node (jsdom; email-reply-parser calls createRequire at import)
// and live in `@omni/mail-core/clean`.
export * from "./parse";
export * from "./thread";
