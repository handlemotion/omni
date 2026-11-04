// Icons exported from the Figma file, used as-is. Each renders at its native size; place it, don't
// resize it. Decorative by default: give the control around it the accessible name.
import redirectArrow from "./redirect-arrow.svg";

function Icon({ src, size }: { src: string; size: number }) {
  return <img data-slot="icon" src={src} width={size} height={size} alt="" className="shrink-0" />;
}

export const IconRedirectArrow = () => <Icon src={redirectArrow} size={28} />;
