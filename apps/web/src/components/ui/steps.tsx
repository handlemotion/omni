import { cn } from "cn";
import type { ReactNode } from "react";

// A vertical timeline of steps: a faded line with one ringed dot per step. Adapted from the
// onboarding reference (Figma node 16:1400) on our tokens.

export function Steps({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <ol data-slot="steps" className={cn("relative flex flex-col gap-8 ps-8", className)}>
      {/* The line runs behind the dots and fades out at both ends. */}
      <span
        aria-hidden
        className="absolute top-1 bottom-1 left-1.75 w-0.5 bg-linear-to-b from-transparent via-border to-transparent"
      />
      {children}
    </ol>
  );
}

export type StepState = "complete" | "current" | "upcoming";

export function Step(props: {
  state: StepState;
  /** Muted line above the title, e.g. "Step 2 · Domain". */
  label: string;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <li
      data-slot="step"
      aria-current={props.state === "current" ? "step" : undefined}
      className="relative flex flex-col"
    >
      <span
        aria-hidden
        className="absolute top-0 -left-8 flex size-4 items-center justify-center rounded-full bg-background ring-1 ring-border"
      >
        <span
          className={cn(
            "size-2 rounded-full",
            props.state === "current" && "bg-foreground",
            props.state === "complete" && "bg-muted-foreground",
            props.state === "upcoming" && "bg-border",
          )}
        />
      </span>
      <span className="text-sm text-muted-foreground">{props.label}</span>
      <span
        className={cn(
          "text-sm",
          props.state === "upcoming" ? "text-muted-foreground" : "text-foreground",
        )}
      >
        {props.title}
      </span>
      {props.description && (
        <p className="pt-2 text-sm text-muted-foreground">{props.description}</p>
      )}
      {props.children && <div className="pt-4">{props.children}</div>}
    </li>
  );
}
