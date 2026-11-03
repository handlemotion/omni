// Icons exported from the Figma file, used as-is. Each renders at its native size; place it, don't
// resize it. Decorative by default: give the control around it the accessible name.
import arrowRight from "./arrow-right.svg";
import chevronDown from "./chevron-down.svg";
import key from "./key.svg";

function Icon({ src, size }: { src: string; size: number }) {
  return <img data-slot="icon" src={src} width={size} height={size} alt="" className="shrink-0" />;
}

export const IconArrowRight = () => <Icon src={arrowRight} size={15} />;
export const IconChevronDown = () => <Icon src={chevronDown} size={12} />;
export const IconKey = () => <Icon src={key} size={15} />;
