import { withWorkspace } from "./current-workspace.ts";
import { api } from "./api.ts";

/**
 * Downloads `url` through a hidden anchor, never by navigating the app: if the Worker answers
 * with an error instead of the file, the browser keeps the page and shows a failed download.
 */
export function downloadFile(url: string) {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "";
  anchor.rel = "noopener";
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

const LONGEST_LINK_BEFORE_POSTING = 4000;
const FRAME_NAME = "omni-download";

/**
 * The files and folders as one zip (W2, `/zip`): a link while the ids fit in an address, else
 * a form posted into a hidden frame, so an error page never replaces the app either.
 */
export function downloadZip(ids: readonly string[], shareId?: string) {
  const base = shareId
    ? api.storage.shared[":shareId"].zip.$url({ param: { shareId } }).toString()
    : withWorkspace(api.storage.zip.$url().toString());
  const url = new URL(base, window.location.origin);
  url.searchParams.set("ids", ids.join(","));
  if (url.toString().length <= LONGEST_LINK_BEFORE_POSTING) return downloadFile(url.toString());
  url.searchParams.delete("ids");
  postInFrame(url.toString(), ids);
}

function postInFrame(action: string, ids: readonly string[]) {
  let frame = document.querySelector<HTMLIFrameElement>(`iframe[name="${FRAME_NAME}"]`);
  if (!frame) {
    frame = document.createElement("iframe");
    frame.name = FRAME_NAME;
    frame.hidden = true;
    document.body.append(frame);
  }
  const form = document.createElement("form");
  form.method = "POST";
  form.action = action;
  form.target = FRAME_NAME;
  form.hidden = true;
  const field = document.createElement("input");
  field.type = "hidden";
  field.name = "ids";
  field.value = ids.join(",");
  form.append(field);
  document.body.append(form);
  form.submit();
  form.remove();
}
