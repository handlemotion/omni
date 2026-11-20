import { Hono } from "hono";
import type { AppEnv } from "../context.ts";
import { bulk } from "./bulk.ts";
import { companies } from "./companies.ts";
import { contracts } from "./contracts.ts";
import { deals } from "./deals.ts";
import { files } from "./files.ts";
import { find } from "./find.ts";
import { notes } from "./notes.ts";
import { people } from "./people.ts";
import { pipeline } from "./pipeline.ts";
import { timelines } from "./timeline.ts";

export const crm = new Hono<AppEnv>()
  .route("/", bulk)
  .route("/", companies)
  .route("/", people)
  .route("/", deals)
  .route("/", pipeline)
  .route("/", contracts)
  .route("/", files)
  .route("/", notes)
  .route("/", timelines)
  .route("/", find);
