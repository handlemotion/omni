import { describe, expect, test } from "vitest";
import { sheetDoc } from "./doc.ts";
import { limitProblem, parseSheet, serializeSheet, SHEET_LIMITS } from "./format.ts";
import { createSheetFile } from "./create.ts";
import { parseCsv, toCsv } from "./csv.ts";
import { csvTab } from "./create.ts";
import { NOW, saved } from "./test-helpers.ts";
import { saveSheet } from "./save.ts";

const FILE = [
  '{"omni":"sheet","v":1,"tabs":[{"id":"t7Qk","name":"Leads","frozen":{"rows":1,"cols":0},"columns":[{"id":"c1aZ","width":180},{"id":"c9Pm","type":"number","format":{"kind":"currency","currency":"MXN","decimals":2}},{"id":"c3Lx","type":"select","options":["Lead","Won","Lost"]},{"id":"c0Rt","type":"number"}],"views":[{"id":"vB2e","name":"Won","filter":[{"col":"c3Lx","op":"is","value":["Won"]}],"sort":[{"col":"c9Pm","dir":"desc"}]}]}]}',
  '{"t":"t7Qk","r":"r8f2","c":{"c1aZ":"Company","c9Pm":"Amount","c3Lx":"Stage","c0Rt":"With tax"}}',
  '{"t":"t7Qk","r":"rEmp"}',
  '{"t":"t7Qk","r":"rc41","c":{"c1aZ":"Acme","c9Pm":1200,"c3Lx":"Won","c0Rt":{"f":"=B3*1.16+B2","v":1392}}}',
  "",
].join("\n");

describe("the file", () => {
  test("file → live document → file is lossless, empty rows and their references included", () => {
    const again = saveSheet(sheetDoc(parseSheet(FILE)), NOW).text;
    expect(again).toBe(FILE);
  });

  test("saving writes each formula's value", () => {
    const doc = sheetDoc(createSheetFile([{ name: "T", rows: [[2, "=A1*21"], ["=1/0"]] }]));
    const lines = saved(doc).text.split("\n");
    expect(lines[1]).toContain('{"f":"=A1*21","v":42}');
    expect(lines[2]).toContain('{"f":"=1/0","e":"#DIV/0!"}');
  });

  test("a file that is not a sheet is refused", () => {
    expect(() => parseSheet('{"omni":"doc"}')).toThrow("not an Omni sheet");
    expect(() => parseSheet("not json")).toThrow(SyntaxError);
  });

  test("the limits refuse", () => {
    const wide = createSheetFile([
      { name: "T", rows: [Array.from({ length: SHEET_LIMITS.columns + 1 }, () => 1)] },
    ]);
    expect(limitProblem(wide)).toMatch(/columns/);
    const long = createSheetFile([{ name: "T", rows: [["x".repeat(SHEET_LIMITS.cellChars + 1)]] }]);
    expect(limitProblem(long)).toMatch(/characters/);
    const heavy = createSheetFile([
      { name: "T", rows: [Array.from({ length: 200 }, () => "x".repeat(32_767))] },
    ]);
    expect(limitProblem(heavy)).toMatch(/larger than 5 MB/);
    const twins = createSheetFile([
      { name: "Leads", rows: [] },
      { name: "leads", rows: [] },
    ]);
    expect(limitProblem(twins)).toBe("two tabs named leads");
    expect(limitProblem(createSheetFile([{ name: "T", rows: [[1]] }]))).toBeNull();
  });

  test("serialize and parse agree", () => {
    const file = createSheetFile([{ name: "T", rows: [["a", 1, true], [], ["=A1"]] }]);
    expect(parseSheet(serializeSheet(file))).toEqual(file);
  });
});

describe("CSV", () => {
  test("round trips quotes, commas, newlines and a BOM", () => {
    const rows = [
      ["name", "note"],
      ['Acme, "Inc."', "two\nlines"],
      ["", " padded "],
    ];
    expect(parseCsv(`﻿${toCsv(rows)}`)).toEqual(rows);
  });

  test("a CSV with a header over numbers freezes its first row and reads numbers", () => {
    const tab = csvTab("Data", "name,amount\nAcme,1200\nBeta,900.5\n");
    expect(tab.frozen_rows).toBe(1);
    expect(tab.rows[1]).toEqual(["Acme", 1200]);
    expect(tab.rows[2]).toEqual(["Beta", 900.5]);
  });
});
