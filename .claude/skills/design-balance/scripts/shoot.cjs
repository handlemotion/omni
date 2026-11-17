#!/usr/bin/env node
const { chromium } = require("playwright");

const [url, selector, out, ...rest] = process.argv.slice(2);
if (!url || !selector || !out) {
  console.error(
    "usage: node shoot.cjs <url> <selector> <out.png> [--click sel] [--hover sel] [--nth n]",
  );
  process.exit(1);
}
const flag = (name) => {
  const i = rest.indexOf(`--${name}`);
  return i === -1 ? undefined : rest[i + 1];
};

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1280, height: 860 },
    deviceScaleFactor: 4,
  });
  await page.goto(url, { waitUntil: "networkidle" });
  const settle = Number(flag("settle") ?? 500);
  await page.waitForTimeout(settle);
  const click = flag("click");
  if (click) {
    await page.locator(click).first().click();
    await page.waitForTimeout(settle);
  }
  const hover = flag("hover");
  if (hover) {
    await page.locator(hover).first().hover();
  } else {
    await page.mouse.move(1270, 850);
  }
  await page.waitForTimeout(settle);
  await page
    .locator(selector)
    .nth(Number(flag("nth") ?? 0))
    .screenshot({ path: out });
  process.stdout.write(`${out}\n`);
  await browser.close();
})();
