import { expect, test } from "vitest";
import { verificationCode } from "./verification-code";

test("verificationCode takes the code set apart on its own line, not the IP, date or year around it", () => {
  const text = [
    "Verification code",
    "",
    "Enter the following verification code when prompted:",
    "",
    "654705",
    "",
    "To protect your account, do not share this code.",
    "",
    "Didn't request this?",
    "This code was requested from 2806:106e:19:29b3:8584:9412:ad7f:9b94, Mexico City, Mexico at 14 November 2026, 23:14 CST. If you didn't make this request, you can safely ignore this email.",
    "",
    "© 2026 Terms",
  ].join("\n");
  expect(verificationCode({ subject: "Your verification code", text })).toBe("654705");
});

test("verificationCode reads the code a sentence or the subject names, and joins digit groups", () => {
  expect(
    verificationCode({
      subject: "Sign in",
      text: "Hi,\nYour login code is 482913. It expires in 10 minutes.",
    }),
  ).toBe("482913");
  expect(
    verificationCode({
      subject: "731 204 is your Acme verification code",
      text: "Thanks for signing up.",
    }),
  ).toBe("731204");
  expect(
    verificationCode({
      subject: "Tu código",
      text: "Tu código de verificación es 9041\nVence en 2026.",
    }),
  ).toBe("9041");
  expect(
    verificationCode({
      subject: "Sign in",
      text: "Your verification code is 482913.\n\nSupport\n12345",
    }),
  ).toBe("482913");
  expect(
    verificationCode({
      subject: "Your verification code: A123456B",
      text: "Your verification code is A123456B.",
    }),
  ).toBe("A123456B");
  expect(
    verificationCode({ subject: "Device verification", text: "Enter this code:\n\nWDJB-MJ4T\n" }),
  ).toBe("WDJB-MJ4T");
});

test("verificationCode returns null rather than guess: no code talk, or two candidates", () => {
  expect(
    verificationCode({ subject: "Your receipt", text: "Order number\n482913\nTotal $1,250.00" }),
  ).toBeNull();
  expect(
    verificationCode({
      subject: "Shipping",
      text: "Ships to zip code 90210. Promo code: 2024SAVE",
    }),
  ).toBeNull();
  expect(
    verificationCode({
      subject: "Codes",
      text: "Your code is 111222.\nYour backup code is 333444.",
    }),
  ).toBeNull();
  expect(
    verificationCode({
      subject: "Security alert",
      text: "We sent a code to your phone in 2026. Charge: $4500.00 at 23:14. Ref #88213344",
    }),
  ).toBeNull();
});
