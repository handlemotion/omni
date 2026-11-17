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
