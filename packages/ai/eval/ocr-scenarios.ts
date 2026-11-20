import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { OcrSource } from "../src/ocr.ts";

const root = new URL("../../../fixtures/drive/", import.meta.url);

/** Each fixture file, how it is sent, and words its transcript must hold. */
export const ocrScenarios: Array<{ id: string; file: string; source: OcrSource; holds: string[] }> =
  [
    {
      id: "receipt",
      file: "receipt.jpg",
      source: { kind: "image", mediaType: "image/jpeg", data: "" },
      holds: ["FAROLITO", "184.00", "pastor"],
    },
    {
      id: "sunset",
      file: "sunset.png",
      source: { kind: "image", mediaType: "image/png", data: "" },
      holds: ["Picture:"],
    },
    {
      id: "minutes-scan",
      file: "minutes-scan.pdf",
      source: { kind: "pdf", data: "" },
      holds: ["--- Page 2 ---", "impermeabilización", "Tomás"],
    },
  ].map((scenario) => ({
    ...scenario,
    source: {
      ...scenario.source,
      data: readFileSync(new URL(scenario.file, root)).toString("base64"),
    } as OcrSource,
  }));

export const ocrRecordingUrl = (id: string) => new URL(`recordings/${id}.json`, root);

/** A request with each file's base64 replaced by its SHA-256, so recordings stay small. */
export function withoutFileData(request: unknown) {
  return JSON.parse(JSON.stringify(request), (key, value: unknown) =>
    key === "data" && typeof value === "string"
      ? `sha256:${createHash("sha256").update(value).digest("hex")}`
      : value,
  ) as unknown;
}
