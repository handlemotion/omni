import omniMark from "./omni-mark.svg";

function Icon({ src, size }: { src: string; size: number }) {
  return <img data-slot="icon" src={src} width={size} height={size} alt="" className="shrink-0" />;
}

export const IconOmniMark = () => <Icon src={omniMark} size={28} />;
