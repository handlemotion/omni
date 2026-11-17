import { cn } from "cn";
import { Badge } from "@/components/ui/badge";

export function CountBadge({ count, className }: { count: number; className?: string }) {
  if (!count) return null;
  return (
    <Badge
      intent="solid"
      isCircle={false}
      className={cn(
        "h-4.5 min-w-4.5 justify-center border-0 px-1 py-0 text-xs/4.5 tabular-nums",
        className,
      )}
    >
      {count > 99 ? "99+" : count}
    </Badge>
  );
}
