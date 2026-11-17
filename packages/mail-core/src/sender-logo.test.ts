import { describe, expect, test } from "vitest";
import { iconLinks, imageWidth, logoCandidates, logoEdge, logoSource } from "./sender-logo.ts";

describe("logoSource", () => {
  test("webmail asks Gravatar; a company address asks its site's domain", () => {
    expect(logoSource("Ana@Gmail.com")).toEqual({ kind: "gravatar", address: "ana@gmail.com" });
    expect(logoSource("news@bounce.acme.co.uk")).toEqual({ kind: "domain", domain: "acme.co.uk" });
    expect(logoSource("hi@em.linear.app")).toEqual({ kind: "domain", domain: "linear.app" });
    expect(logoSource("root@localhost")).toBeNull();
  });
});

describe("iconLinks", () => {
  test("the largest raster icon comes first; SVG and the mask icon are left out", () => {
    const html = `
      <link rel="icon" type="image/svg+xml" href="/icon.svg">
      <link rel="mask-icon" href="/mask.png" color="#000">
      <link rel="shortcut icon" href="/favicon.ico">
      <link rel=icon sizes="32x32" href="/f-32.png">
      <link href='/touch.png?v=1&amp;b=2' rel="apple-touch-icon">
      <LINK REL="icon" SIZES="192x192" HREF="https://cdn.acme.com/icon-192.png">`;
    expect(iconLinks(html, "https://acme.com/en/")).toEqual([
      { url: "https://cdn.acme.com/icon-192.png", size: 192 },
      { url: "https://acme.com/touch.png?v=1&b=2", size: 180 },
      { url: "https://acme.com/f-32.png", size: 32 },
      { url: "https://acme.com/favicon.ico", size: 0 },
    ]);
  });

  test("the conventional paths follow the page's own icons, without repeats", () => {
    const links = [{ url: "https://acme.com/apple-touch-icon.png", size: 180 }];
    expect(logoCandidates("acme.com", links, "https://icons.example/{domain}.png")).toEqual([
      "https://acme.com/apple-touch-icon.png",
      "https://icons.example/acme.com.png",
      "https://acme.com/favicon.ico",
    ]);
  });
});

describe("imageWidth", () => {
  test("an ICO's widest image counts; 0 means 256", () => {
    const ico = new Uint8Array(6 + 16 * 3);
    ico.set([0, 0, 1, 0, 3, 0]);
    ico[6] = 16;
    ico[22] = 64;
    ico[38] = 32;
    expect(imageWidth(ico)).toBe(64);
    ico[38] = 0;
    expect(imageWidth(ico)).toBe(256);
  });

  test("a PNG's width is in its header", () => {
    const png = new Uint8Array(24);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    png.set([0, 0, 0, 180], 16);
    expect(imageWidth(png)).toBe(180);
  });
});

describe("logoEdge", () => {
  const bitmap = (size: number, pixel: (x: number, y: number) => number[]) => {
    const data = new Uint8ClampedArray(size * size * 4);
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) data.set(pixel(x, y), (y * size + x) * 4);
    return data;
  };
  const orange = [244, 129, 32, 255];

  test("a solid tile with rounded corners reads as its colour", () => {
    const corner = (x: number, y: number) => (x < 2 || x > 29) && (y < 2 || y > 29);
    const rgba = bitmap(32, (x, y) => (corner(x, y) ? [0, 0, 0, 0] : orange));
    expect(logoEdge(rgba, 32, 32)).toEqual({ kind: "solid", color: "#f48120" });
  });

  test("a mark on nothing is transparent; a photo to the edge is busy", () => {
    const glyph = bitmap(32, (x, y) =>
      x > 8 && x < 24 && y > 8 && y < 24 ? orange : [0, 0, 0, 0],
    );
    expect(logoEdge(glyph, 32, 32)).toEqual({ kind: "transparent" });
    const photo = bitmap(32, (x, y) => [x * 8, y * 8, 128, 255]);
    expect(logoEdge(photo, 32, 32)).toEqual({ kind: "busy" });
  });
});
