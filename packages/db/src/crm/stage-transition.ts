// A deal's stage rules (ADR 0036 decision 2) in one place, so a route, a bulk move and an agent
// cannot disagree. Pure: no I/O. Applying a move to its own result changes nothing, so a
// repeated move writes no event.
//
// - Moving sets `stageEnteredAt`.
// - The first entry into a `won` stage sets `wonAt`. It is never reset: a deal moved back to open
//   and won again keeps the first date, which is when the project started.
// - Entering `done` or `lost` sets `closedAt` (to the time of this entry, also from one closed
//   kind to another).
// - Entering `open` or `won` clears `closedAt`: a reopened deal is not closed, and a won deal is
//   a running project, not a closed one.
// - A move to the stage the deal is in changes nothing.

export type StageKind = "open" | "won" | "done" | "lost";

export interface DealStageState {
  stageId: string;
  kind: StageKind;
  stageEnteredAt: Date;
  wonAt: Date | null;
  closedAt: Date | null;
}

export interface StageTarget {
  stageId: string;
  kind: StageKind;
}

export interface DealStageTransition {
  state: DealStageState;
  /** False when the move leaves the deal as it was: write no event. */
  changed: boolean;
}

const closes = (kind: StageKind) => kind === "done" || kind === "lost";

/** The state of a deal created in `target` at `now`. */
export function enterFirstStage(target: StageTarget, now: Date) {
  return {
    stageId: target.stageId,
    kind: target.kind,
    stageEnteredAt: now,
    wonAt: target.kind === "won" ? now : null,
    closedAt: closes(target.kind) ? now : null,
  } satisfies DealStageState;
}

/** The deal's state after it is moved to `target` at `now`. Never throws. */
export const moveDealStage: (
  state: DealStageState,
  target: StageTarget,
  now: Date,
) => DealStageTransition = (state, target, now) => {
  if (state.stageId === target.stageId) return { state, changed: false };
  return {
    state: {
      stageId: target.stageId,
      kind: target.kind,
      stageEnteredAt: now,
      wonAt: state.wonAt ?? (target.kind === "won" ? now : null),
      closedAt: closes(target.kind) ? now : null,
    },
    changed: true,
  };
};
