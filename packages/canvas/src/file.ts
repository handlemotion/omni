/**
 * An Omni canvas's type. Its body is a JSON scene, so search, agents, history and sync read it as
 * text, but it is a board of its own: named without an extension, opened in its own editor.
 */
export const CANVAS_TYPE = "text/vnd.omni.canvas";

/** Whether a file is an Omni canvas. */
export const isOmniCanvas = (mimeType: string | null | undefined) =>
  mimeType?.split(";")[0]?.trim().toLowerCase() === CANVAS_TYPE;
