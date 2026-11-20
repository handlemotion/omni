import type { StorageNode } from "./storage.ts";
import { storageFileUrl } from "./urls.ts";

/** A file's whole content as text, as saved. */
export async function fileText(node: StorageNode) {
  const response = await fetch(storageFileUrl(node.id));
  if (!response.ok) throw new Error(`the file did not load (${response.status})`);
  return response.text();
}
