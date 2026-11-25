import type { Page } from "playwright-core";

type Files = Parameters<Page["setInputFiles"]>[1];

/**
 * Uploads `files` into the folder on screen the way a person would: an empty folder's own Upload,
 * else the header's New menu and Upload files (a folder with items has no Upload button of its own).
 * Neither shows until the folder has loaded, so it waits for one of them first.
 */
export async function uploadFiles(page: Page, files: Files) {
  const header = page.locator("header").getByRole("button", { name: "New", exact: true });
  const upload = page.getByRole("main").getByRole("button", { name: "Upload", exact: true });
  await header.or(upload).first().waitFor();
  if ((await header.count()) === 0) {
    await page.locator("input[type=file]:not([webkitdirectory])").first().setInputFiles(files);
    return;
  }
  const chooser = page.waitForEvent("filechooser");
  await header.first().click();
  await page.getByRole("menuitem", { name: "Upload files" }).click();
  await (await chooser).setFiles(files as Parameters<Awaited<typeof chooser>["setFiles"]>[0]);
}
