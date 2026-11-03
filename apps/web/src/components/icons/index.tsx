// Icons exported from the Figma file, used as-is. Each renders at its native size; place it, don't
// resize it. Decorative by default: give the control around it the accessible name.
import arrowRight from "./arrow-right.svg";
import chevronDown from "./chevron-down.svg";
import googleMask from "./google-mask.svg";
import google from "./google.svg";
import key from "./key.svg";

function Icon({ src, size }: { src: string; size: number }) {
  return <img data-slot="icon" src={src} width={size} height={size} alt="" className="shrink-0" />;
}

export const IconArrowRight = () => <Icon src={arrowRight} size={15} />;
export const IconChevronDown = () => <Icon src={chevronDown} size={12} />;
export const IconKey = () => <Icon src={key} size={15} />;

/** The Google "G": a gradient artwork clipped by the logo shape, exactly as Figma exports it. */
export function IconGoogle() {
  return (
    <span data-slot="icon" aria-hidden className="relative size-icon shrink-0 overflow-clip">
      <span
        className="absolute inset-[-0.43%_-0.75%_-0.73%_-0.75%] mask-alpha mask-intersect mask-no-clip mask-no-repeat mask-position-[0.112px_0.064px] mask-size-[15px_15px]"
        style={{ maskImage: `url("${googleMask}")` }}
      >
        <span className="absolute inset-[-17.74%_-3.09%_-3.1%_-11.53%]">
          <img src={google} alt="" className="block size-full max-w-none" />
        </span>
      </span>
    </span>
  );
}
