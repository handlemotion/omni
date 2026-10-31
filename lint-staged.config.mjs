/** @type {import('lint-staged').Configuration} */
export default {
  "*.{js,jsx,ts,tsx,mjs,cjs,json,jsonc,css,md,yml,yaml}": "oxfmt --no-error-on-unmatched-pattern",
  "*.{js,jsx,ts,tsx,mjs,cjs}": "oxlint --fix",
  "**/*.test.{ts,tsx,mts}": () => "node scripts/check-tests.mjs",
};
