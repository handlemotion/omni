import type { InvitationMessage } from "@omni/auth";
import type { Config } from "./env.ts";
import type { Logger } from "./log.ts";

export interface SystemMessage {
  to: string;
  subject: string;
  text: string;
}

/**
 * Auth and notice mail (magic links, invitations, domain notices) goes out through Cloudflare Email
 * Sending (the `EMAIL` binding), from `SYSTEM_MAIL_FROM` under the app's name. It does not use a
 * mailbox, so a new install can sign people in before it has any.
 */
export function systemMailSender(scope: { email: SendEmail; config: Config; log: Logger }) {
  return async (message: SystemMessage) => {
    const from = scope.config.SYSTEM_MAIL_FROM;
    if (!from) throw new Error("SYSTEM_MAIL_FROM is not set: there is no address to send from");
    try {
      await scope.email.send({
        from: { email: from, name: scope.config.auth.appName },
        to: message.to,
        subject: message.subject,
        text: message.text,
      });
    } catch (error) {
      scope.log.error("system_mail.failed", { code: (error as { code?: string }).code, error });
      throw error;
    }
  };
}

export function signInCodeMail(
  input: { email: string; signInAs: string; otp: string },
  appName: string,
) {
  const as = input.signInAs.toLowerCase() === input.email ? "" : ` as ${input.signInAs}`;
  return {
    to: input.email,
    subject: `${input.otp} is your ${appName} sign-in code${as}`,
    text: `Your ${appName} sign-in code${as} is:\n\n${input.otp}\n\nIt expires in 10 minutes. If you did not ask for it, ignore this email.`,
  } satisfies SystemMessage;
}

export function invitationMail(invite: InvitationMessage, appName: string) {
  return {
    to: invite.email,
    subject: `${invite.inviterName} invited you to ${invite.organizationName} on ${appName}`,
    text: [
      `${invite.inviterName} invited you to join ${invite.organizationName} on ${appName}.`,
      "",
      `Open this link to accept:`,
      "",
      invite.url,
      "",
      `It expires on ${invite.expiresAt.toUTCString()}. If you did not expect it, ignore this email.`,
    ].join("\n"),
  } satisfies SystemMessage;
}

/** In development only, prints the code or link so you can sign in without a mail binding. */
export function devLog(
  config: Config,
  payload: { kind: string; email: string; url?: string; otp?: string },
) {
  if (config.ENVIRONMENT !== "development") return;
  console.log(JSON.stringify({ event: "auth.dev_link", ...payload }));
}
