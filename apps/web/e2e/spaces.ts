import type { Page } from "playwright-core";

const LEGACY = new Set(["files", "mail", "crm", "calendar", "meetings", "settings", "inbox"]);

/**
 * Makes a private space in the workspace `page` is in (it must be on a page inside one), opens
 * it, and returns its id: where a test's files go, now that My files and Shared are retired.
 */
export async function openSpace(page: Page, name = "Files") {
  await page.waitForURL((url) => {
    const [first = "", second] = url.pathname.split("/").filter(Boolean);
    return !!second && !LEGACY.has(first);
  });
  const { origin, pathname } = new URL(page.url());
  const slug = decodeURIComponent(pathname.split("/")[1] ?? "");
  const listed = await page.request.get(`${origin}/api/workspaces?include=personal`);
  const { workspaces } = (await listed.json()) as { workspaces: { id: string; slug: string }[] };
  const workspace = workspaces.find((each) => each.slug === slug);
  if (!workspace) throw new Error(`no workspace ${slug}`);
  const made = await page.request.post(`${origin}/api/storage/teamspaces`, {
    data: { name, private: true },
    headers: { "omni-workspace": workspace.id },
  });
  if (made.status() !== 201) throw new Error(`space ${name}: ${made.status()}`);
  const { teamspace } = (await made.json()) as { teamspace: { id: string } };
  await page.goto(
    `${origin}/${encodeURIComponent(slug)}/files/t/${encodeURIComponent(teamspace.id)}`,
  );
  return teamspace.id;
}
