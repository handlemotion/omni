import omniMark from "./omni-mark.svg";

function Icon({ src, size }: { src: string; size: number }) {
  return <img data-slot="icon" src={src} width={size} height={size} alt="" className="shrink-0" />;
}

export const IconOmniMark = () => <Icon src={omniMark} size={28} />;

/** The globe from the Omni mark alone, no tile, in the current text colour. */
export function IconOmniGlobe({ size = 32, className }: { size?: number; className?: string }) {
  return (
    <svg
      data-slot="icon"
      width={size}
      height={size}
      viewBox="3.92 3.92 20.16 20.16"
      fill="currentColor"
      aria-hidden
      className={className}
    >
      <path
        fillRule="evenodd"
        d="M3.92 14a10.08 10.08 0 1 0 20.16 0a10.08 10.08 0 1 0 -20.16 0ZM14 3.92A10.728 10.728 0 0 0 14 24.08A12.919 12.919 0 0 1 14 3.92ZM14 3.92A10.728 10.728 0 0 1 14 24.08A12.919 12.919 0 0 0 14 3.92Z"
      />
    </svg>
  );
}
