/**
 * The workspace (organization id) a request is for. The web app sends the one in its URL, so two
 * tabs can be in two workspaces at once; the Worker answers as the user's member there,
 * or 403 when they have none. Without it, the session's active organization is used, as before.
 * Member-scoped answers carry it back, naming the workspace they were read from.
 */
export const WORKSPACE_HEADER = "omni-workspace";

/**
 * The same, as a query parameter, for requests the browser makes itself and so cannot carry a
 * header: a download it navigates to, an image or file preview it loads.
 */
export const WORKSPACE_PARAM = "workspace";
