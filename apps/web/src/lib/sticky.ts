export type Ease = (t: number) => number;

const EXPO = 1 - 2 ** -10;

/** Landing curves, as ease-outs on [0, 1]. The take-off plays the same curve mirrored. */
export const eases = {
  power1: (t: number) => 1 - (1 - t) ** 2,
  power2: (t: number) => 1 - (1 - t) ** 3,
  power3: (t: number) => 1 - (1 - t) ** 4,
  expo: (t: number) => (1 - 2 ** (-10 * t)) / EXPO,
} satisfies Record<string, Ease>;

export type EaseName = keyof typeof eases;

const SLOPES: Record<EaseName, number> = {
  power1: 2,
  power2: 3,
  power3: 4,
  expo: (10 * Math.LN2) / EXPO,
};

const slope = (E: Ease) => {
  const d = (h: number) => (E(h) - E(0)) / h;
  return 2 * d(5e-5) - d(1e-4);
};

export type Curve = {
  /** scroll the element stays stuck for, sticky's own range */
  travel: number;
  /** the landing window, in scroll past the point where sticky engages */
  into: [number, number];
  /** the take-off window, likewise */
  outof: [number, number];
  /** the correction at x: positive holds the element low, negative lifts it early */
  at: (x: number) => number;
  /** sticky's own offset with its corners rounded off, for a page that has no sticky */
  clamp: (x: number) => number;
};

export type CurveOptions = {
  /** scroll the element stays stuck for, sticky's own range */
  travel: number;
  /** scroll one landing, or one take-off, lasts */
  span: number;
  /** the landing curve, a name from `eases` or any ease-out */
  ease?: EaseName | Ease;
  /** scroll there is before sticky engages; a landing cannot begin above the page */
  lead?: number;
};

export const curve = ({ travel, span, ease = "power2", lead = Infinity }: CurveOptions) => {
  const E = typeof ease === "function" ? ease : eases[ease];
  const m = typeof ease === "function" ? slope(ease) : SLOPES[ease];
  const rounds = m > 1;

  let land = rounds ? Math.min(span / m, Math.max(0, lead)) : 0;
  let lift = rounds ? span / m : 0;

  const past = rounds ? m - 1 : 0;

  const need = past * (land + lift);
  if (need > travel) {
    land *= travel / need;
    lift *= travel / need;
  }

  const into: [number, number] = [-land, past * land];
  const outof: [number, number] = [travel - past * lift, travel + lift];

  const bump = (t: number) => Math.min(m * t, 1) - E(t);

  const at = (x: number) => {
    if (x > into[0] && x < into[1]) return land * bump((x - into[0]) / (into[1] - into[0]));
    if (x > outof[0] && x < outof[1]) return -lift * bump((outof[1] - x) / (outof[1] - outof[0]));
    return 0;
  };

  return {
    travel,
    into,
    outof,
    at,
    clamp: (x) => Math.min(Math.max(x, 0), travel) + at(x),
  } satisfies Curve;
};

type ViewTimelineCtor = new (options: { subject: Element; axis: "block" }) => AnimationTimeline;
type RangeOptions = KeyframeAnimationOptions & {
  timeline: AnimationTimeline;
  rangeStart: string;
  rangeEnd: string;
};

const ViewTimeline =
  typeof window === "undefined"
    ? undefined
    : (window as { ViewTimeline?: ViewTimelineCtor }).ViewTimeline;

/** Scroll-driven animations, and the WAAPI half of them this uses. */
export const supported =
  !!ViewTimeline && CSS.supports("(animation-timeline: view()) and (animation-range: entry)");

export type StickyOptions = {
  /** scroll a landing, and a take-off, lasts, as a fraction of the viewport's height — 0.4 */
  distance?: number;
  /** the landing curve: a name from `eases`, or any ease-out — 'power2' */
  ease?: EaseName | Ease;
  /** where the correction runs; everywhere else the element is plain sticky — pointer devices */
  media?: string;
  /** 'compositor' needs scroll-driven animations, 'main' writes from the ticker, 'auto' takes
   *  the compositor wherever there is one — 'auto' */
  engine?: "auto" | "compositor" | "main";
  /** the frame loop the main-thread engine writes on, returning its unsubscribe —
   *  requestAnimationFrame. Subscribed only while the parent is near the viewport, so it is
   *  called again each time the parent comes back */
  ticker?: (fn: () => void) => () => void;
};

export type Sticky = {
  readonly curve: Curve | null;
  /** what is applying the correction right now, if anything */
  readonly engine: "compositor" | "main" | null;
  /** measure again, for a change neither box's size shows */
  refresh: () => void;
  /** set the correction down where it stands and stop following the scroll */
  freeze: () => void;
  destroy: () => void;
};

const POINTER = "(hover: hover) and (pointer: fine)";

const SAMPLES = 48;

export const keyframes = (
  { into, outof, travel, at }: Curve,
  write = (y: number) => `0 ${y}px`,
) => {
  const [a, b] = [into[0], outof[1]];
  const xs = new Set([a, 0, into[1], outof[0], travel, b]);

  for (const [from, to] of [into, outof]) {
    for (let i = 1; i < SAMPLES; i++) xs.add(from + ((to - from) * i) / SAMPLES);
  }

  return [...xs]
    .filter((x) => x >= a && x <= b)
    .sort((u, v) => u - v)
    .map((x) => ({ offset: (x - a) / (b - a), translate: write(at(x)) }));
};

const COVER = "data-sticky-cover";

const lift = (y: number) => `0 ${-Math.max(0, y)}px`;

const coverStyles = () => {
  if (document.getElementById(COVER)) return;
  const style = document.createElement("style");
  style.id = COVER;
  style.textContent = `[${COVER}]::before{content:"";position:absolute;inset:0;z-index:-1;background:inherit;pointer-events:none;translate:0 calc(-1 * var(--sticky-cover, 0px))}`;
  document.head.append(style);
};

const canCover = (el: HTMLElement) =>
  el.hasAttribute(COVER) || getComputedStyle(el, "::before").content === "none";

const raf = (fn: () => void) => {
  let id = requestAnimationFrame(function loop() {
    id = requestAnimationFrame(loop);
    fn();
  });

  return () => cancelAnimationFrame(id);
};

const scrollerOf = (from: Element) => {
  const root = document.documentElement;

  for (let a: Element | null = from; a && a !== root; a = a.parentElement) {
    if (a === document.body && getComputedStyle(root).overflowY === "visible") continue;

    const overflow = getComputedStyle(a).overflowY;
    if (overflow !== "visible" && overflow !== "clip" && a instanceof HTMLElement) return a;
  }

  return null;
};

const port = (scroller: HTMLElement | null) => {
  if (!scroller) return { top: 0, scroll: scrollY, height: document.documentElement.clientHeight };

  return {
    top: scroller.getBoundingClientRect().top + scroller.clientTop,
    scroll: scroller.scrollTop,
    height: scroller.clientHeight,
  };
};

const one = (
  el: HTMLElement,
  {
    distance = 0.4,
    ease = "power2",
    media = POINTER,
    engine = "auto",
    ticker = raf,
  }: StickyOptions = {},
) => {
  const parent = el.parentElement;
  if (!parent) throw new Error("sticky: the element has no parent to stick within");

  const gate = matchMedia(media);
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const timeline =
    engine !== "main" && supported && ViewTimeline
      ? new ViewTimeline({ subject: parent, axis: "block" })
      : null;

  let c: Curve | null = null;
  let engage = 0;
  let anim: Animation | null = null;
  let cover: Animation | null = null;
  let untick: (() => void) | null = null;
  let frozen = false;
  let scroller: HTMLElement | null = null;

  let built: number[] | null = null;

  const stop = () => {
    anim?.cancel();
    anim = null;
    cover?.cancel();
    cover = null;
    untick?.();
    untick = null;
    built = null;
    el.style.translate = "";
    el.style.removeProperty("--sticky-cover");
    el.removeAttribute(COVER);
  };

  const offset = () => parseFloat(getComputedStyle(el).translate.split(" ")[1] ?? "") || 0;

  const measure = (shift: number) => {
    const s = getComputedStyle(el);
    const top = parseFloat(s.top);
    if (s.position !== "sticky" || !Number.isFinite(top)) return null;

    const found = scrollerOf(parent);
    if (found !== scroller && found) ro.observe(found);
    scroller = found;
    const view = port(scroller);

    const position = el.style.position;
    el.style.position = "static";
    const r = el.getBoundingClientRect();
    const p = parent.getBoundingClientRect();
    el.style.position = position;

    const ps = getComputedStyle(parent);
    const floor = p.bottom - parseFloat(ps.borderBottomWidth) - parseFloat(ps.paddingBottom);

    const flow = { top: r.top - shift, bottom: r.bottom - shift };

    const engage = flow.top - p.top - top;
    const travel = Math.max(0, floor - flow.bottom - parseFloat(s.marginBottom));
    const span = distance * view.height;
    const lead = view.scroll + flow.top - view.top - top;

    return {
      engage,
      span,
      curve: curve({ travel, span, ease, lead }),
      from: [engage, travel, span, lead],
    };
  };

  const refresh = () => {
    if (frozen) return;

    const running = !!(anim || untick);
    const runs = gate.matches && !reduced.matches;

    if (!runs || !running) stop();

    const next = runs ? measure(running ? offset() : 0) : null;

    if (next && built && next.from.every((v, i) => Math.abs(v - (built?.[i] ?? NaN)) < 0.01))
      return;

    stop();
    c = next?.curve ?? null;
    if (!next) return;

    engage = next.engage;

    const { into, outof, at } = next.curve;
    if (into[1] - into[0] + (outof[1] - outof[0]) <= 0) return;

    built = next.from;

    const covered = into[1] > into[0] && canCover(el);
    if (covered) {
      coverStyles();
      el.setAttribute(COVER, "");
    }

    if (timeline) {
      const options: RangeOptions = {
        timeline,

        rangeStart: `exit-crossing ${engage + into[0]}px`,
        rangeEnd: `exit-crossing ${engage + outof[1]}px`,
        fill: "none",
      };

      anim = el.animate(keyframes(next.curve), options);
      if (covered)
        cover = el.animate(keyframes(next.curve, lift), { ...options, pseudoElement: "::before" });
      return;
    }

    let last = 0;

    const tick = () => {
      const y = at(port(scroller).top - parent.getBoundingClientRect().top - engage);
      if (y === last) return;

      last = y;
      el.style.translate = y ? `0 ${y}px` : "";
      if (covered) el.style.setProperty("--sticky-cover", `${Math.max(0, y)}px`);
    };

    let off: (() => void) | null = ticker(tick);

    const near = new IntersectionObserver(
      (entries) => {
        if (entries[entries.length - 1]?.isIntersecting) off ??= ticker(tick);
        else {
          off?.();
          off = null;
        }
      },
      { root: scroller, rootMargin: `${Math.ceil(next.span)}px 0px` },
    );

    near.observe(parent);
    tick();

    untick = () => {
      near.disconnect();
      off?.();
      off = null;
    };
  };

  const freeze = () => {
    if (frozen) return;
    frozen = true;

    if (anim) {
      try {
        anim.commitStyles();
      } catch {}
      anim.cancel();
      anim = null;
    }
    cover?.cancel();
    cover = null;

    untick?.();
    untick = null;
  };

  const ro = new ResizeObserver(() => refresh());
  ro.observe(el);
  ro.observe(parent);

  addEventListener("resize", refresh);
  gate.addEventListener("change", refresh);
  reduced.addEventListener("change", refresh);

  if (document.readyState !== "complete") addEventListener("load", refresh, { once: true });

  refresh();

  return {
    get curve() {
      return c;
    },
    get engine() {
      return anim ? "compositor" : untick ? "main" : null;
    },
    refresh,
    freeze,
    destroy() {
      ro.disconnect();
      removeEventListener("load", refresh);
      removeEventListener("resize", refresh);
      gate.removeEventListener("change", refresh);
      reduced.removeEventListener("change", refresh);

      if (frozen) return;
      stop();
    },
  } satisfies Sticky;
};

export const stickySelectors = (sheets: Iterable<{ readonly cssRules: Iterable<unknown> }>) => {
  type Rule = {
    selectorText?: string;
    style?: { position?: string };
    cssRules?: Iterable<unknown>;
    styleSheet?: { readonly cssRules: Iterable<unknown> } | null;
  };

  const selectors: string[] = [];
  let unread = 0;

  const walk = (rules: Iterable<unknown>) => {
    for (const rule of rules as Iterable<Rule>) {
      if (rule.selectorText && rule.style?.position === "sticky") selectors.push(rule.selectorText);
      if (rule.cssRules) walk(rule.cssRules);
      if (rule.styleSheet) open(rule.styleSheet);
    }
  };

  const open = (sheet: { readonly cssRules: Iterable<unknown> }) => {
    try {
      walk(sheet.cssRules);
    } catch {
      unread++;
    }
  };

  for (const sheet of sheets) open(sheet);

  return { selectors, unread };
};

/**
 * The elements a page's own CSS makes sticky, at this width or any other:
 * what its stylesheets' sticky rules match, and anything made sticky inline.
 */
export const findSticky = (root: Document = document) => {
  const { selectors, unread } = stickySelectors([...root.styleSheets, ...root.adoptedStyleSheets]);
  const found = new Set<HTMLElement>();

  for (const selector of [...selectors, '[style*="sticky"]']) {
    try {
      for (const el of root.querySelectorAll<HTMLElement>(selector)) found.add(el);
    } catch {}
  }

  if (unread) {
    for (const el of root.querySelectorAll<HTMLElement>("*")) {
      if (getComputedStyle(el).position === "sticky") found.add(el);
    }
  }

  return [...found];
};

export type StickyAll = {
  /** every element taken on, and its stick */
  readonly sticks: ReadonlyMap<HTMLElement, Sticky>;
  /** look again: a sticky that arrived since gets a stick, one that left the document loses its */
  scan: () => void;
  /** measure every stick again */
  refresh: () => void;
  /** set every correction down where it stands */
  freeze: () => void;
  destroy: () => void;
};

const own = (el: HTMLElement, options: StickyOptions) => {
  const { stickyEase: ease, stickyDistance } = el.dataset;
  if (ease === "off") return null;

  const distance = Number(stickyDistance);

  return {
    ...options,
    ...(ease && Object.hasOwn(eases, ease) ? { ease: ease as EaseName } : null),
    ...(stickyDistance && Number.isFinite(distance) ? { distance } : null),
  } satisfies StickyOptions;
};

function all(options?: StickyOptions): StickyAll;
function all(selector: string, options?: StickyOptions): StickyAll;
function all(first?: string | StickyOptions, second: StickyOptions = {}) {
  const selector = typeof first === "string" ? first : null;
  const options = (typeof first === "string" ? second : first) ?? {};

  const sticks = new Map<HTMLElement, Sticky>();
  let frozen = false;

  const scan = () => {
    if (frozen) return;

    for (const [el, stick] of sticks) {
      if (el.isConnected) continue;

      stick.destroy();
      sticks.delete(el);
    }

    const found = selector ? document.querySelectorAll<HTMLElement>(selector) : findSticky();

    for (const el of found) {
      if (sticks.has(el) || !el.parentElement) continue;

      const mine = own(el, options);
      if (mine) sticks.set(el, one(el, mine));
    }
  };

  scan();

  const loaded = () => scan();
  if (document.readyState !== "complete") addEventListener("load", loaded, { once: true });

  return {
    sticks,
    scan,
    refresh: () => sticks.forEach((stick) => stick.refresh()),
    freeze() {
      frozen = true;
      sticks.forEach((stick) => stick.freeze());
    },
    destroy() {
      removeEventListener("load", loaded);
      sticks.forEach((stick) => stick.destroy());
      sticks.clear();
    },
  } satisfies StickyAll;
}

/**
 * Round off an element's sticky corners. It keeps its own position: sticky and
 * `top`; the correction goes on `translate`. `sticky.all()` does it for
 * every sticky on the page.
 *
 * @alpacka/sticky 0.2.1 (the `sticky` skill, github.com/jesperlandberg/alpacka),
 * forked to measure against the nearest scroll container instead of the root
 * scroller only, since every signed-in screen scrolls inside its own box.
 * While a sticky lands it trails its line, so a `::before` in its own
 * background rises with it to cover the strip above.
 */
export const sticky = Object.assign(one, { all });
