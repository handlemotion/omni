import { expect, test } from "vitest";
import { firstName, renderTemplate } from "./templates";

test("a missing variable takes its fallback, else renders empty and is reported", () => {
  // Bug caught: "Hi {{customer.first_name}}" going to a customer as the literal braces, or as
  // "Hi ," with nothing telling the agent before they send.
  const values = { "customer.first_name": null, "agent.name": "Ana" };
  expect(
    renderTemplate("Hi {{customer.first_name | there}}, {{ agent.name }} here.", values),
  ).toEqual({
    text: "Hi there, Ana here.",
    missing: [],
  });
  expect(renderTemplate("Hi {{customer.first_name}}, re {{order.id}}.", values)).toEqual({
    text: "Hi , re .",
    missing: ["customer.first_name", "order.id"],
  });
});

test("HTML rendering escapes values, so a customer's name cannot inject markup", () => {
  // Bug caught: a sender named `<script>` ending up live in the HTML of our reply.
  const { text } = renderTemplate(
    "<p>Hi {{customer.name}}</p>",
    { "customer.name": '<img src=x onerror="x">' },
    { html: true },
  );
  expect(text).toBe("<p>Hi &lt;img src=x onerror=&quot;x&quot;&gt;</p>");
});

test("first name is the first word, and absent for a blank name", () => {
  expect(firstName("  Luis   Pérez ")).toBe("Luis");
  expect(firstName("   ")).toBeNull();
});

test("a template naming an Object property renders as missing instead of throwing", () => {
  // Bug caught: `{{constructor}}` read Object.prototype.constructor, `.trim` threw, and saving
  // or using the canned reply answered 500.
  expect(renderTemplate("{{constructor}}{{__proto__ | there}}{{toString}}", {})).toEqual({
    text: "there",
    missing: ["constructor", "tostring"],
  });
});

test("a long run of braces and spaces renders in linear time", () => {
  // Bug caught: the variable regex backtracked polynomially (CodeQL), so one pasted template
  // could pin a Worker isolate.
  const hostile = `{{{{_|${" ".repeat(50_000)}`;
  const started = performance.now();
  expect(renderTemplate(hostile, {}).text).toBe(hostile);
  expect(performance.now() - started).toBeLessThan(200);
});
