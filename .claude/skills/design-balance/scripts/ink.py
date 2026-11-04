#!/usr/bin/env python3
"""Measure ink (the pixels people see) in a screenshot, not element boxes.

Take screenshots at deviceScaleFactor 4 and pass --scale 4; every number prints in CSS px.

  ink.py bands  <png> [--scale 4] [--border 1] [--corner 10]
      For a container screenshot (a menu, a card, a panel clipped to its border box): each
      horizontal band of ink, its height and the gap above it, then the inset from the inner edge
      to the nearest ink on all four sides. --corner skips the antialiased rounded corners.

  ink.py marks  <png> [--scale 4] [--lead 0.2] [--trail 0.1]
      For one row's screenshot: the ink box of its leading mark (left fraction --lead) and of its
      trailing mark (right fraction --trail), against the row's own edges.

  ink.py centre <png> [--scale 4]
      For one avatar or badge screenshot: how far its glyph's ink centre sits below (+) or right
      (+) of the disc's centre. A hair above the middle (about -0.1 to -0.3px) reads centred.

Ink is any pixel that differs from the sampled fill by more than --threshold (default 6 on a
0-255 grey scale; use 90 for `centre`, which compares a glyph to its disc).
"""
import argparse
from PIL import Image


def load(path):
    return Image.open(path).convert("L")


def is_ink(value, fill, threshold):
    return abs(value - fill) > threshold


def bands(args):
    im = load(args.png)
    w, h = im.size
    k, b, rad = args.scale, round(args.border * args.scale), round(args.corner * args.scale)
    fill = im.getpixel((w // 2, b + 2))
    rows = [
        any(is_ink(im.getpixel((x, y)), fill, args.threshold) for x in range(b + rad, w - b - rad))
        for y in range(b, h - b)
    ]
    cols = [
        any(is_ink(im.getpixel((x, y)), fill, args.threshold) for y in range(b + rad, h - b - rad))
        for x in range(b, w - b)
    ]
    found, start = [], None
    for i, ink in enumerate(rows + [False]):
        if ink and start is None:
            start = i
        if not ink and start is not None:
            found.append((start, i))
            start = None
    if not found:
        print("no ink")
        return
    prev = 0
    for s, e in found:
        print(f"band top {s / k:6.2f}  h {(e - s) / k:6.2f}  gap above {(s - prev) / k:6.2f}")
        prev = e
    print(f"gap below last {(len(rows) - prev) / k:6.2f}")
    left = cols.index(True)
    right = len(cols) - 1 - cols[::-1].index(True)
    print(
        f"insets: top {found[0][0] / k:.2f}  bottom {(len(rows) - found[-1][1]) / k:.2f}"
        f"  left {left / k:.2f}  right {(len(cols) - 1 - right) / k:.2f}"
    )


def ink_box(im, x0, x1, fill, threshold):
    xs, ys = [], []
    for y in range(im.size[1]):
        for x in range(x0, x1):
            if is_ink(im.getpixel((x, y)), fill, threshold):
                xs.append(x)
                ys.append(y)
    return (min(xs), min(ys), max(xs), max(ys)) if xs else None


def marks(args):
    im = load(args.png)
    w, h = im.size
    k = args.scale
    fill = im.getpixel((w // 2, 1))
    print(f"row {w / k:.0f}x{h / k:.0f}px")
    lead = ink_box(im, 0, int(w * args.lead), fill, args.threshold)
    trail = ink_box(im, w - int(w * args.trail), w, fill, args.threshold)
    if lead:
        print(f"lead  ink: top {lead[1] / k:5.2f}  left {lead[0] / k:5.2f}  bottom {(h - 1 - lead[3]) / k:5.2f}")
    if trail:
        print(f"trail ink: top {trail[1] / k:5.2f}  right {(w - 1 - trail[2]) / k:5.2f}  bottom {(h - 1 - trail[3]) / k:5.2f}")


def centre(args):
    im = load(args.png)
    w, h = im.size
    k = args.scale
    disc = im.getpixel((w // 2, int(h * 0.12)))
    box = ink_box(im, 0, w, disc, args.threshold)
    if not box:
        print("no ink")
        return
    cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
    print(
        f"size {w / k:.1f}px  ink h {(box[3] - box[1] + 1) / k:.2f}px"
        f"  down {(cy - (h - 1) / 2) / k:+.2f}px  right {(cx - (w - 1) / 2) / k:+.2f}px"
    )


parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
parser.add_argument("mode", choices=["bands", "marks", "centre"])
parser.add_argument("png")
parser.add_argument("--scale", type=float, default=4)
parser.add_argument("--border", type=float, default=1)
parser.add_argument("--corner", type=float, default=10)
parser.add_argument("--lead", type=float, default=0.2)
parser.add_argument("--trail", type=float, default=0.1)
parser.add_argument("--threshold", type=int)
args = parser.parse_args()
if args.threshold is None:
    args.threshold = 90 if args.mode == "centre" else 6
{"bands": bands, "marks": marks, "centre": centre}[args.mode](args)
