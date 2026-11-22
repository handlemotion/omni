import { useCanGoBack, useRouter, useRouterState } from "@tanstack/react-router";
import { IconChevronLeft, IconChevronRight } from "@/components/icons/sidebar";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger } from "@/components/ui/tooltip";

type Navigation = { canGoForward?: boolean };

const canGoForward = () =>
  (window as unknown as { navigation?: Navigation }).navigation?.canGoForward ?? true;

function Arrow(props: { label: string; isDisabled: boolean; onPress: () => void; back?: boolean }) {
  return (
    <TooltipTrigger delay={400}>
      <Button
        intent="ghost"
        size="sq-sm"
        aria-label={props.label}
        isDisabled={props.isDisabled}
        onPress={props.onPress}
        className="disabled:opacity-40"
      >
        {props.back ? <IconChevronLeft /> : <IconChevronRight />}
      </Button>
      <Tooltip>{props.label}</Tooltip>
    </TooltipTrigger>
  );
}

/** Back and forward through the pages this window has shown, as a desktop app's title bar has. */
export function NavArrows() {
  const router = useRouter();
  const back = useCanGoBack();
  useRouterState({ select: (state) => state.location.href });
  return (
    <span className="flex">
      <Arrow label="Previous page" back isDisabled={!back} onPress={() => router.history.back()} />
      <Arrow
        label="Next page"
        isDisabled={!canGoForward()}
        onPress={() => router.history.forward()}
      />
    </span>
  );
}
