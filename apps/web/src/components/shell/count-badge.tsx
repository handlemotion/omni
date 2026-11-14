// The unread count, as the sidebar's Inbox row shows it: square, 18px a side for one digit and
// wider only for more, primary on a light tint that multiplies, so on a filled row it reads a
// step darker. Nothing at zero. Every unread count in the app uses this one.
import { cn } from "cn";
import { Badge } from "@/components/ui/badge";

export function CountBadge({ count, className }: { count: number; className?: string }) {
  if (!count) return null;
  return (
    <Badge
      intent="primary"
      isCircle={false}
      className={cn(
        "h-4.5 min-w-4.5 justify-center bg-unread-count px-1 py-0 text-xs/4.5 tabular-nums mix-blend-multiply",
        className,
      )}
    >
      {count > 99 ? "99+" : count}
    </Badge>
  );
}
