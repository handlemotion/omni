import { describe, expect, test } from "vitest";
import { layoutToken, readGrid } from "./doc.ts";
import { docOf, edit, firstTab, peer, sync } from "./test-helpers.ts";

const names = (doc: Parameters<typeof firstTab>[0]) => firstTab(doc).map((row) => row[0]);

describe("concurrent row inserts", () => {
  test("two peers inserting between the same rows keep both, in the same order", () => {
    const a = docOf({ name: "Leads", rows: [["Acme"], ["Beta"]] });
    const b = peer(a);
    edit(a, { insert_rows: { after: 1 } }, { set: "A2", value: "from a" });
    edit(b, { insert_rows: { after: 1 } }, { set: "A2", value: "from b" });
    sync(a, b);
    expect(names(a)).toEqual(names(b));
    expect(names(a).toSorted()).toEqual(["Acme", "Beta", "from a", "from b"]);
  });

  test("a row can be inserted between two rows whose keys are equal", () => {
    const doc = docOf({ name: "Leads", rows: [["Acme"], ["Beta"]] });
    const rows = [...readGrid(doc).tabs[0]!.rows];
    doc.getMap<import("yjs").Map<unknown>>("rows").get(rows[1]!.id)!.set("p", rows[0]!.p);
    const [first, second] = names(doc);
    edit(doc, { insert_rows: { before: 2 } }, { set: "A2", value: "between" });
    expect(names(doc)).toEqual([first, "between", second]);
  });
});

describe("sorts", () => {
  const rows = [
    ["Name", "Amount"],
    ["c", 3],
    ["a", 1],
    ["b", 2],
    ["d", 4],
  ];

  test("two concurrent sorts leave every row exactly once", () => {
    const a = docOf({ name: "T", rows, frozen_rows: 1 });
    const b = peer(a);
    edit(a, { sort: { by: [{ column: "A" }] } });
    edit(b, { sort: { by: [{ column: "B", desc: true }] } });
    sync(a, b);
    expect(names(a)).toEqual(names(b));
    expect(names(a).toSorted()).toEqual(["Name", "a", "b", "c", "d"]);
    expect(names(a)[0]).toBe("Name");
  });

  test("a sort and a concurrent insert lose and double nothing", () => {
    const a = docOf({ name: "T", rows, frozen_rows: 1 });
    const b = peer(a);
    edit(a, { sort: { by: [{ column: "A" }] } });
    edit(b, { insert_rows: { after: 2 } }, { set: "A3", values: [["new"]] });
    sync(a, b);
    expect(names(a)).toEqual(names(b));
    expect(names(a).toSorted()).toEqual(["Name", "a", "b", "c", "d", "new"]);
  });

  test("a sort orders by value, blanks last, header kept", () => {
    const doc = docOf({
      name: "T",
      rows: [
        ["Name", "Amount"],
        ["x", 3],
        ["y", null],
        ["z", "=1+1"],
      ],
      frozen_rows: 1,
    });
    edit(doc, { sort: { by: [{ column: "B" }] } });
    expect(names(doc)).toEqual(["Name", "z", "x", "y"]);
  });
});

describe("deletes", () => {
  test("a change to a row deleted at the same time is dropped", () => {
    const a = docOf({
      name: "T",
      rows: [
        ["Acme", 1],
        ["Beta", 2],
      ],
    });
    const b = peer(a);
    edit(a, { delete_rows: "2" });
    edit(b, { set: "B2", value: 99 });
    sync(a, b);
    expect(firstTab(a)).toEqual([["Acme", 1]]);
    expect(firstTab(b)).toEqual([["Acme", 1]]);
  });
});

describe("the layout token", () => {
  test("changes when a concurrent insert merges in, not when a cell changes", () => {
    const a = docOf({ name: "T", rows: [["Acme"], ["Beta"]] });
    const b = peer(a);
    edit(a, { insert_rows: { before: 1 } });
    const read = layoutToken(readGrid(a));
    edit(b, { insert_rows: { before: 2 } });
    sync(a, b);
    expect(layoutToken(readGrid(a))).not.toBe(read);
    const settled = layoutToken(readGrid(a));
    edit(a, { set: "A1", value: "renamed" });
    expect(layoutToken(readGrid(a))).toBe(settled);
  });
});
