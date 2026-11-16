// The CRM's HTTP API (ADR 0036 decision 7, docs/spec/crm.md "API"), mounted at `/api/crm` inside
// the member API: every route acts as the session's member in the active workspace, and every
// write passes the read-only gate (`requireWritableWorkspace`), so a workspace without a plan in
// good standing reads its CRM and answers `402 billing_inactive` to every change. A Personal
// space has no CRM: every route answers `404 no_crm`. Each successful write announces
// `crm.changed` on the workspace's realtime object.
import { Hono } from "hono";
import type { AppEnv } from "../context.ts";
import { companies } from "./companies.ts";
import { deals } from "./deals.ts";
import { find } from "./find.ts";
import { notes } from "./notes.ts";
import { people } from "./people.ts";
import { pipeline } from "./pipeline.ts";
import { timelines } from "./timeline.ts";

export const crm = new Hono<AppEnv>()
  .route("/", companies)
  .route("/", people)
  .route("/", deals)
  .route("/", pipeline)
  .route("/", notes)
  .route("/", timelines)
  .route("/", find);
