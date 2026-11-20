import type { DropItem } from "react-aria-components";
import { isDirectoryDropItem, isFileDropItem } from "react-aria-components/useDrop";
import { api, ApiError, call } from "./api.ts";
import type { StorageNode, StoragePlace } from "./storage.ts";
import { withRetry, type Slots } from "./storage-upload-net.ts";

/** A file to upload, and the folders between where it was dropped and the file (may be none). */
export interface PickedFile {
  file: File;
  dir: string[];
}

/** What a drop or a pick holds: its files, and every folder in it, empty ones included. */
export interface Picked {
  files: PickedFile[];
  folders: string[][];
}

const flat = (files: File[]) =>
  ({ files: files.map((file) => ({ file, dir: [] })), folders: [] }) satisfies Picked;

/** Files from the folder picker (`webkitdirectory`): each knows its path under the folder. */
export function pickedFromInput(files: File[]) {
  const picked: Picked = { files: [], folders: [] };
  const seen = new Set<string>();
  for (const file of files) {
    const path = (file.webkitRelativePath || file.name).split("/").filter(Boolean);
    const dir = path.slice(0, -1);
    for (let depth = 1; depth <= dir.length; depth++) {
      const folder = dir.slice(0, depth);
      const key = folder.join("/");
      if (!seen.has(key)) {
        seen.add(key);
        picked.folders.push(folder);
      }
    }
    picked.files.push({ file, dir });
  }
  return picked;
}

/**
 * What a native drop holds, folders walked. Call it inside the `drop` handler: the browser
 * empties `dataTransfer` once the handler returns, so the entries are taken first, then read.
 */
export function pickedFromTransfer(transfer: DataTransfer | null) {
  if (!transfer) return Promise.resolve<Picked>(flat([]));
  const entries = [...transfer.items].flatMap((item) => {
    if (item.kind !== "file") return [];
    const entry = item.webkitGetAsEntry?.();
    return entry ? [entry] : [];
  });
  if (!entries.length) return Promise.resolve<Picked>(flat([...transfer.files]));
  return walkEntries(entries);
}

async function walkEntries(roots: FileSystemEntry[]) {
  const picked: Picked = { files: [], folders: [] };
  const queue = roots.map((entry) => ({ entry, dir: [] as string[] }));
  for (let next = queue.shift(); next; next = queue.shift()) {
    const { entry, dir } = next;
    if (isFileEntry(entry)) {
      const file = await new Promise<File | null>((resolve) =>
        entry.file(resolve, () => resolve(null)),
      );
      if (file) picked.files.push({ file, dir });
    } else if (isDirectoryEntry(entry)) {
      const here = [...dir, entry.name];
      picked.folders.push(here);
      for (const child of await readAll(entry.createReader()))
        queue.push({ entry: child, dir: here });
    }
  }
  return picked;
}

const isFileEntry = (entry: FileSystemEntry): entry is FileSystemFileEntry => entry.isFile;
const isDirectoryEntry = (entry: FileSystemEntry): entry is FileSystemDirectoryEntry =>
  entry.isDirectory;

async function readAll(reader: FileSystemDirectoryReader) {
  const all: FileSystemEntry[] = [];
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve) =>
      reader.readEntries(resolve, () => resolve([])),
    );
    if (!batch.length) return all;
    all.push(...batch);
  }
}

/** What a React Aria drop holds, folders walked through its own directory items. */
export async function pickedFromDropItems(items: DropItem[]) {
  const picked: Picked = { files: [], folders: [] };
  const queue = items.map((item) => ({ item, dir: [] as string[] }));
  for (let next = queue.shift(); next; next = queue.shift()) {
    const { item, dir } = next;
    if (isFileDropItem(item)) {
      picked.files.push({ file: await item.getFile(), dir });
    } else if (isDirectoryDropItem(item)) {
      const here = [...dir, item.name];
      picked.folders.push(here);
      for await (const child of item.getEntries()) queue.push({ item: child, dir: here });
    }
  }
  return picked;
}

/**
 * Makes the folders of one drop or pick under `root`, each once, parents first, and answers the
 * place each path lands in. The top folders take a number when their name is taken, as New
 * folder does; inside a folder just made, nothing is taken.
 */
export class FolderMaker {
  readonly #made = new Map<string, Promise<StoragePlace>>();
  readonly root: StoragePlace;
  readonly shareId: string | undefined;
  readonly slots: Slots;
  readonly onMade: (node: StorageNode) => void;
  constructor(
    root: StoragePlace,
    shareId: string | undefined,
    slots: Slots,
    onMade: (node: StorageNode) => void,
  ) {
    this.root = root;
    this.shareId = shareId;
    this.slots = slots;
    this.onMade = onMade;
  }

  placeFor(dir: string[], signal: AbortSignal) {
    let at = Promise.resolve(this.root);
    for (let depth = 1; depth <= dir.length; depth++) {
      const key = dir.slice(0, depth).join("/");
      const known = this.#made.get(key);
      if (known) {
        at = known;
        continue;
      }
      const name = dir[depth - 1] ?? "";
      const made = at.then((parent) => this.#create(parent, name, signal));
      made.catch(() => this.#made.delete(key));
      this.#made.set(key, made);
      at = made;
    }
    return at;
  }

  async #create(parent: StoragePlace, name: string, signal: AbortSignal) {
    const json = { name, ...parent };
    const shareId = this.shareId;
    const { node } = await withRetry(
      () =>
        this.slots.run(
          () =>
            shareId
              ? call(api.storage.shared[":shareId"].folders.$post({ param: { shareId }, json }))
              : call(api.storage.folders.$post({ json })),
          signal,
        ),
      { signal, tries: 8, transient: (error) => error instanceof ApiError && error.status === 429 },
    );
    this.onMade(node);
    return { parentId: node.id } satisfies StoragePlace;
  }
}
