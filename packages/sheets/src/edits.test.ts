import { describe, expect, test } from "vitest";
import { applySheetEdits } from "./edits.ts";
import { diffSheets } from "./diff.ts";
import { rangeValues } from "./render.ts";
import { evaluateDoc } from "./save.ts";
import { docOf, edit, firstTab, NOW, saved, text, values } from "./test-helpers.ts";

describe("edits", () => {
  test("all of them or none", () => {
    const doc = docOf({ name: "T", rows: [[1]] });
    const outcome = applySheetEdits(
      doc,
      [
        { set: "A1", value: 2 },
        { tab: "Missing", set: "A1", value: 3 },
      ],
      NOW,
    );
    expect(outcome).toEqual({ ok: false, error: "Edit 2: there is no tab named Missing" });
    expect(firstTab(doc)).toEqual([[1]]);
  });

  test("set fills a range, growing the sheet, and answers what changed", () => {
    const doc = docOf({ name: "Leads", rows: [["Company", "Amount"]] });
    const outcome = edit(doc, {
      set: "A2:C3",
      values: [
        ["Beta", 900, "=B2*2"],
        ["Gamma", 400, "=B3*2"],
      ],
    });
    expect(outcome.changed).toEqual(["Leads!A2:C3"]);
    expect(rangeValues(evaluateDoc(doc, NOW), ["Leads!C2:C3"])).toBe(
      "Leads!C2 = 1800\nLeads!C3 = 800",
    );
    expect(firstTab(doc)).toEqual([
      ["Company", "Amount", null],
      ["Beta", 900, 1800],
      ["Gamma", 400, 800],
    ]);
  });

  test("what changed is where the cells sit after the later edits of the same call", () => {
    const doc = docOf({ name: "Leads", rows: [["Company"]] });
    const outcome = applySheetEdits(
      doc,
      [
        { set: "B1", value: "Amount" },
        { insert_rows: { before: 1 } },
        { insert_columns: { before: "A" } },
        { rename_tab: "Pipeline" },
      ],
      NOW,
    );
    expect(outcome).toMatchObject({ ok: true, changed: ["Pipeline!C2"] });
  });

  test("cells written and then deleted in the same call are not answered as changed", () => {
    const doc = docOf({ name: "T", rows: [[1], [2]] });
    const outcome = applySheetEdits(
      doc,
      [{ set: "A3", value: 3 }, { set: "A1", value: 0 }, { delete_rows: "3" }],
      NOW,
    );
    expect(outcome).toMatchObject({ ok: true, changed: ["T!A1"] });
  });

  test("a sort after a column's type changed sorts by the new type", () => {
    const doc = docOf({
      name: "T",
      rows: [
        ["2026-11-23", "=A1+1"],
        ["2026-11-22", "=A2+1"],
      ],
    });
    edit(doc, { column: "A", type: "date" }, { sort: { range: "A1:B2", by: [{ column: "B" }] } });
    expect(saved(doc).text.indexOf("2026-11-22")).toBeLessThan(
      saved(doc).text.indexOf("2026-11-23"),
    );
  });

  test("an edit whose computed values would pass 5 MB is refused", () => {
    const doc = docOf({ name: "T", rows: [] });
    const big = Array.from({ length: 200 }, () => '=REPT("x",32767)');
    const outcome = applySheetEdits(doc, [{ set: "A1", values: [big] }], NOW);
    expect(outcome).toEqual({ ok: false, error: "The sheet would have a file larger than 5 MB." });
  });

  test("a range of the wrong shape is refused", () => {
    const doc = docOf({ name: "T", rows: [] });
    const outcome = applySheetEdits(doc, [{ set: "A1:B1", values: [[1], [2]] }], NOW);
    expect(outcome.ok).toBe(false);
  });

  test("append lands after the last row with a value, and says where", () => {
    const doc = docOf({ name: "T", rows: [["a"], ["b"]] });
    const outcome = edit(doc, {
      append: [
        ["c", 3],
        ["d", 4],
      ],
    });
    expect(outcome.changed).toEqual(["T!A3:B4"]);
    expect(firstTab(doc).map((r) => r[0])).toEqual(["a", "b", "c", "d"]);
  });

  test("text that starts with = is written '=", () => {
    const doc = docOf({ name: "T", rows: [] });
    edit(doc, { set: "A1", value: "'=not a formula" });
    expect(firstTab(doc)).toEqual([["=not a formula"]]);
  });

  test("columns, tabs, freeze and views", () => {
    const doc = docOf({
      name: "Leads",
      rows: [
        ["Name", "Stage"],
        ["Acme", "Won"],
      ],
    });
    edit(
      doc,
      { column: "B", type: "select", options: ["Lead", "Won"] },
      { freeze: { rows: 1 } },
      {
        view: {
          name: "Won",
          filter: [{ column: "B", op: "is", value: "Won" }],
          sort: [{ column: "A" }],
        },
      },
      { add_tab: "Q4" },
      { tab: "Q4", set: "A1", value: "=COUNTA(Leads!A:A)" },
      { tab: "Leads", rename_tab: "Pipeline" },
    );
    expect(values(doc)[1]).toEqual([[2]]);
    const shown = text(doc);
    expect(shown).toContain("--- Sheet: Pipeline (A1:B2, frozen 1 row) ---");
    expect(shown).toContain("Columns: B select (Lead, Won)");
    expect(shown).toContain('Views: Won (B is "Won"; sort A asc)');
    expect(shown).toContain("A1 =COUNTA(Pipeline!A:A)");
  });

  test("edits in one call see the sheet the edits before them left", () => {
    const doc = docOf({ name: "T", rows: [[1], [2]] });
    edit(doc, { clear: "A2" }, { append: [[3]] });
    expect(firstTab(doc)).toEqual([[1], [3]]);
    edit(
      doc,
      { view: { name: "Big", sort: [{ column: "A" }] } },
      { view: { name: "Big", hidden: ["A"] } },
    );
    expect(text(doc).match(/Views: .*/)?.[0]).toBe("Views: Big (hides A)");
  });

  test("delete columns and insert columns", () => {
    const doc = docOf({ name: "T", rows: [[1, 2, 3]] });
    edit(
      doc,
      { delete_columns: "B" },
      { insert_columns: { before: "A" } },
      { set: "A1", value: 0 },
    );
    expect(firstTab(doc)).toEqual([[0, 1, 3]]);
  });
});

describe("what an agent reads", () => {
  test("a run holds only cells whose formula is the first one moved down", () => {
    const doc = docOf({
      name: "T",
      rows: [
        [1, null],
        [2, "=A1"],
        [3, "=A1"],
        [4, "=A3"],
        [5, "=A4"],
      ],
    });
    expect(text(doc)).toContain("Formulas:\nB2 =A1\nB3 =A1\nB4:B5 =A3\n");
  });

  test("rows by number under column letters, with formulas in runs", () => {
    const doc = docOf({
      name: "Leads",
      rows: [
        ["Company", "Amount", "With tax"],
        ["Acme", 1200, "=B2*1.16"],
        ["Beta", 900, "=B3*1.16"],
      ],
      frozen_rows: 1,
    });
    expect(text(doc)).toBe(
      [
        "--- Sheet: Leads (A1:C3, frozen 1 row) ---",
        "\tA\tB\tC",
        "1\tCompany\tAmount\tWith tax",
        "2\tAcme\t1200\t1392",
        "3\tBeta\t900\t1044",
        "Formulas:",
        "C2:C3 =B2*1.16",
        "",
      ].join("\n"),
    );
  });
});

describe("diffs", () => {
  test("compare cells by id, so a row inserted above changes nothing else", () => {
    const doc = docOf({
      name: "T",
      rows: [
        ["a", 1],
        ["b", 2],
      ],
    });
    const before = saved(doc).file;
    edit(
      doc,
      { insert_rows: { before: 1 } },
      { set: "A1", value: "new" },
      { set: "B3", value: 20 },
    );
    expect(diffSheets(before, saved(doc).file)).toBe(["T: row 1 added", "T!B3: 2 → 20"].join("\n"));
  });

  test("a row inserted above formulas does not show them as changed", () => {
    const doc = docOf({
      name: "T",
      rows: [
        [1, "=A1*2"],
        [2, "=A2*2"],
      ],
    });
    const before = saved(doc).file;
    edit(doc, { insert_rows: { before: 1 } });
    expect(diffSheets(before, saved(doc).file)).toBe("");
  });
});
