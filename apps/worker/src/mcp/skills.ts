import {
  memorySkillFiles,
  SkillCatalog,
  type SkillsExtension,
} from "@modelcontextprotocol/server/ext/skills";

const FILES = {
  "report-feedback/SKILL.md": `---
name: report-feedback
description: Tell the people who build Wok about a problem with its tools, through \`report_feedback\`. Use when a Wok tool errors, answers wrongly, confuses you, is slow, or cannot do what the person asked.
---

# Reporting feedback on Wok's tools

\`report_feedback\` reaches the people who build Wok's tools. They read every report and fix
tools from them, so a good report changes what the next agent gets.

## When to report

Report a problem once, as soon as you have worked around it or given up on it:

- **bug**: a tool returned an error, or failed where it should have worked.
- **wrong_result**: an answer that contradicts what the tool's description promises, or another
  tool (a thread \`search\` finds that \`fetch\` says does not exist).
- **confusing**: a description, a parameter or an error message that sent you down the wrong
  path, and what you did before you found the right one.
- **missing**: something the person asked for that no tool can do, or a filter or field you had
  to work around with extra calls.
- **slow**: a call that took long enough to hold up the answer.

Finish the person's task first, then report. Tell the person in one sentence that you sent
feedback to Wok, and what about.

## What to write

- \`summary\`: one line, the problem itself ("\`search\` ignores \`from\` when \`query\` is set").
- \`details\`: what you called (tool and argument names, the shape of the values), what you
  expected, what you got, and the error text word for word. Enough for an engineer to reproduce
  it without asking you.
- \`proposed_fix\`: the change you would make to the tool, its description or its schema, as
  concretely as you can. This is the most useful part of a report.
- \`tool\`: the tool it is about, when it is about one.

Describe the person's data by its shape, never its content: "a thread with 40 messages and a
PDF", "a sender on a subdomain". Ids from tool results are fine. Message text, names, addresses
and file contents stay out of the report: they belong to the person and the people who wrote
to them.
`,
};

let catalog: Promise<SkillsExtension> | undefined;

/**
 * The skills the MCP server bundles (the Skills extension, SEP-2640), built once per isolate:
 * clients list them with `skills/list` and read `skill://<name>/SKILL.md`. In memory, since the
 * Worker has no filesystem; a skill's `name` must match its folder.
 */
export function skills() {
  catalog ??= SkillCatalog.load(memorySkillFiles(FILES), { strict: true });
  return catalog;
}
