---
name: design-balance
description: Optical balance for Omni's UI, measured in ink. Use for any UI change in apps/web (building, restyling or reviewing a screen, menu, row, avatar or control), and whenever spacing, alignment or detail feels cramped, uneven or busy.
---

# Design balance

Omni's UI is quiet, spacious and minimal. Balance is decided in **ink** (the pixels a person
sees), never in element boxes: a text line box carries invisible slack, an icon glyph carries air
inside its box, and 12px between boxes is not 12px between what the eye reads. This skill is the
loop and the rules for getting it right. `DESIGN.md` (repo root) still decides the look: Figma,
tokens, components.

## The loop

1. **Read** `DESIGN.md` and the Figma frame. Keep the look; work on room, alignment and detail.
2. **Plan the geometry in words** before writing classes: for each mark (avatar, icon, check,
   label, text block), name the box it lives in and the distance it keeps from each edge of that
   box. Write that down in a comment beside the constants that produce it.
3. **Build** with components and tokens.
4. **Measure** every state the change touches (rest, hover, open or pressed, chosen, the longest
   real text) on the real local stack (`pnpm stack:up`, the Worker, the web app):

   ```bash
   node .claude/skills/design-balance/scripts/shoot.cjs http://localhost:5173/inbox "[role=menu]" /tmp/menu.png --click "[aria-label^='Switch mailbox']"
   python3 .claude/skills/design-balance/scripts/ink.py bands /tmp/menu.png
   ```

   `bands` gives every gap and the four insets of a container; `marks` gives where a row's leading
   and trailing marks sit inside the row; `centre` gives a glyph's offset inside its disc. Also
   check that no text clips: each line's glyph range sits inside its box.

5. **Fix by adding room.** When something is tight, give it more space and leave every other gap
   as it is or larger. Then measure again.
6. **Look** at the screenshot at 2x, in every measured state, and compare against the numbers.
   The eye is the final judge; the numbers make it honest.

Done when every inset and gap is measured and listed, each mark's pairs (top and left, top and
right) are within 1px, nothing clips, and you have looked at every state. Report the numbers. A
screen that only rendered with stubbed data is reported as stubbed.

## Rules

**Room**

- Generous by default: content sits 16px or more from a menu's or card's edge; rows give a
  two-line block its full line heights (16px for 11 to 13px text) and 2px between lines.
- A fix adds room. Trading space (taking it from the label to give it to the row) only moves
  the cramp somewhere else.

**Balance**

- Each mark is even inside its own box: an avatar the same distance from its row's top and left,
  a check the same distance from its row's top and right. Measure the ink, then correct for the
  glyph's own air with a commented nudge.
- Concentric corners: an inner radius is the outer radius minus the padding between them.
- Marks across components share axes: a trigger's avatar centre and label start line up with the
  nav icons and labels under it.
- Glyphs sit at the optical centre, a hair above the geometric middle (-0.1 to -0.3px at 28 to
  32px).

**Grouping**

- A label belongs to what follows it: more space above it than below, and both gaps roomy (about
  24px to the group above, 16px to its own rows).
- Equal things get equal gaps: one rhythm between rows of the same kind.

**Detail**

- Minimal: one line of text where one does the job. A heading needs no subtitle that restates it,
  a field no status line under it, a progress bar no "Step 2 of 4" over it.
- An explanation lives on the control it explains, as a tooltip shown on hover and keyboard focus.
- Letters below about 14px are specks: draw the mark plain (a disc, a dot) and carry the detail
  in the row beside it.
- Overlapping marks never cover a letter; separate them with a ring in the fill behind them, so
  they also read under a hover highlight.

**States**

- Every fill follows the state's fill behind it: avatars multiply under a hover highlight;
  separator rings take the highlight's colour on the hovered row.
- React Aria keeps a menu trigger pressed while its menu is open, so open, pressed and hover share
  one fill through the button's own variables.
- Tactility adds depth, press and motion on top of the Figma look; it never restyles it.
