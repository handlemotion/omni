import { useContext, useState, type ReactNode } from "react";
import { FieldErrorContext } from "react-aria-components/FieldError";
import { IconCircleAlert } from "@/components/icons/lucide";

/**
 * An error that opens under its control instead of appearing all at once (chowmein's sign-in
 * fields): the space (one line plus 12px above it) grows first, so what's below slides down
 * rather than jumping, and the line fades and drops in once there's room, so its edge is never
 * seen cut off. Closing runs the other way. Keep it mounted and pass `null` for no error.
 */
export function RevealedError({ children }: { children: ReactNode }) {
  // Keep the last message while it closes, so the text doesn't vanish before the line does.
  const [shown, setShown] = useState<ReactNode>(children);
  if (children && children !== shown) setShown(children);
  const open = Boolean(children);
  return (
    <div
      // Always mounted, so screen readers announce the message when it arrives.
      role="alert"
      className={`grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none ${open ? "grid-rows-[1fr]" : "grid-rows-[0fr] delay-100"}`}
    >
      <div className="overflow-hidden">
        <ErrorLine open={open} className="pt-3">
          {shown}
        </ErrorLine>
      </div>
    </div>
  );
}

/**
 * The same line for a form's own error, in room the layout already keeps (the gap above the
 * submit button): nothing moves, the line only fades and drops in. A message longer than one
 * line grows the room; most are one line.
 */
export function SlotError({ children, className }: { children: ReactNode; className?: string }) {
  const [shown, setShown] = useState<ReactNode>(children);
  if (children && children !== shown) setShown(children);
  return (
    <div role="alert" className={className}>
      <ErrorLine open={Boolean(children)}>{shown}</ErrorLine>
    </div>
  );
}

/**
 * Inside a React Aria `TextField`: opens with `message` (or the browser's own) while the field is
 * invalid, which it becomes when its form is submitted with it empty or malformed. The browser's
 * bubble never shows, and typing a valid value closes it.
 */
export function FieldRevealedError({ message }: { message?: string }) {
  const validation = useContext(FieldErrorContext);
  const invalid = validation?.isInvalid ?? false;
  return (
    <RevealedError>{invalid ? (message ?? validation?.validationErrors[0]) : null}</RevealedError>
  );
}

/** A small alert mark and one short line of small red text. */
function ErrorLine(props: { open: boolean; className?: string; children: ReactNode }) {
  return (
    <p
      aria-hidden={!props.open}
      className={`flex items-start gap-1 text-xs/4 text-danger-subtle-foreground transition-[opacity,translate] ease-out motion-reduce:transition-none ${props.open ? "translate-y-0 opacity-100 delay-100 duration-200" : "-translate-y-1 opacity-0 duration-100"} ${props.className ?? ""}`}
    >
      {/* Optical: on the first line's centre, so a wrapped message keeps the mark beside its start. */}
      <IconCircleAlert aria-hidden className="mt-px size-3.5 shrink-0" />
      <span>{props.children}</span>
    </p>
  );
}
