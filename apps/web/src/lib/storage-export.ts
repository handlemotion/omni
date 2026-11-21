import type { StorageNode } from "./storage.ts";
import { storageFileUrl } from "./urls.ts";

/** A file's whole content as text, as saved. */
export async function fileText(node: StorageNode) {
  const response = await fetch(storageFileUrl(node.id));
  if (!response.ok) throw new Error(`the file did not load (${response.status})`);
  return response.text();
}

/** A file's whole content as UTF-8 text; refuses bytes that are not valid UTF-8 rather than mangle them. */
export async function fileTextExact(node: StorageNode) {
  const response = await fetch(storageFileUrl(node.id));
  if (!response.ok) throw new Error(`the file did not load (${response.status})`);
  const bytes = await response.arrayBuffer();
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("the file is not UTF-8 text");
  }
}
