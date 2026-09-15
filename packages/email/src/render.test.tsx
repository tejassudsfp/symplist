import { pretty } from "@react-email/render";
import { describe, expect, it } from "vitest";
import { EmailConfigurationError, EmailValidationError } from "./errors.ts";
import {
  createEmailRenderer,
  type ReminderEmailInput,
  type RenderedEmail,
  renderOtpEmail,
  toEmailMessage,
} from "./render.tsx";
import { type OtpPurpose, otpPurposes } from "./templates/otp.tsx";
import { emailColors, emailContrastPairs } from "./templates/theme.ts";

const renderer = createEmailRenderer({
  webOrigin: "https://app.symplist.example",
  apiOrigin: "https://api.symplist.example",
  accountHelpUrl: "https://symplist.example/help/account",
});

// Fictional values only.
const code = "482913";
const taskUrl = "https://app.symplist.example/now/0192f0a0-0000-7000-8000-000000000101";
const preferencesUrl = "https://app.symplist.example/settings/notifications";
const oneClickUrl = "https://api.symplist.example/v1/reminders/unsubscribe?token=fictional-token";
const dueAt = Date.UTC(2026, 8, 18, 17, 0); // Friday 10:00 in Los Angeles
const intendedAt = Date.UTC(2026, 8, 18, 16, 0);

const reminderBase: ReminderEmailInput = {
  due: { kind: "timed", at: dueAt, timeZone: "America/Los_Angeles" },
  preview: { kind: "generic" },
  openTaskUrl: taskUrl,
  preferencesUrl,
};

async function snapshot(name: string, email: RenderedEmail) {
  await expect(`Subject: ${email.subject}\n\n${email.text}`).toMatchFileSnapshot(
    `__snapshots__/${name}.txt.snap`,
  );
  await expect(await pretty(email.html)).toMatchFileSnapshot(`__snapshots__/${name}.html.snap`);
}

function hrefs(html: string): string[] {
  return [...html.matchAll(/href="([^"]*)"/g)].map((match) =>
    (match[1] ?? "").replaceAll("&amp;", "&"),
  );
}

function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5].map(
    (offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255,
  );
  const [r, g, b] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

function contrast(a: string, b: string): number {
  const [light, dark] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
}

/** Every rendered template, for invariants that hold across all of them. */
async function allEmails(): Promise<Array<[string, RenderedEmail]>> {
  return [
    ...(await Promise.all(
      otpPurposes.map(
        async (purpose) =>
          [`otp-${purpose}`, await renderOtpEmail({ purpose, code, expiresInMinutes: 10 })] as [
            string,
            RenderedEmail,
          ],
      ),
    )),
    [
      "vault-reset-notice",
      await renderer.vaultResetNotice({ changedAt: dueAt, timeZone: "America/Los_Angeles" }),
    ],
    ["reminder-generic", await renderer.reminder(reminderBase)],
    [
      "reminder-title",
      await renderer.reminder({
        ...reminderBase,
        preview: { kind: "title", title: "Refresh my portfolio" },
      }),
    ],
    [
      "reminder-delayed",
      await renderer.reminder({
        ...reminderBase,
        delayed: { intendedAt, timeZone: "America/Los_Angeles" },
      }),
    ],
  ];
}

describe("rendered templates (snapshots)", () => {
  it.each(otpPurposes)("renders the %s OTP email", async (purpose) => {
    await snapshot(`otp-${purpose}`, await renderOtpEmail({ purpose, code, expiresInMinutes: 10 }));
  });

  it("renders the Vault key reset notification", async () => {
    await snapshot(
      "vault-reset-notice",
      await renderer.vaultResetNotice({ changedAt: dueAt, timeZone: "America/Los_Angeles" }),
    );
  });

  it("renders the generic reminder", async () => {
    await snapshot("reminder-generic", await renderer.reminder(reminderBase));
  });

  it("renders the explicit title preview reminder", async () => {
    await snapshot(
      "reminder-title",
      await renderer.reminder({
        ...reminderBase,
        preview: { kind: "title", title: "Refresh my portfolio" },
      }),
    );
  });

  it("renders delayed wording for a generic late reminder", async () => {
    await snapshot(
      "reminder-delayed",
      await renderer.reminder({
        ...reminderBase,
        delayed: { intendedAt, timeZone: "America/Los_Angeles" },
      }),
    );
  });

  it("renders delayed wording with a title preview and a date-only deadline", async () => {
    await snapshot(
      "reminder-delayed-title-date",
      await renderer.reminder({
        ...reminderBase,
        due: { kind: "date", date: "2026-09-19", timeZone: "Asia/Kolkata" },
        preview: { kind: "title", title: "Book a bike tune-up" },
        delayed: { intendedAt, timeZone: "Asia/Kolkata" },
      }),
    );
  });
});

describe("one light, high-contrast design", () => {
  it("meets 4.5:1 for every text and background pair", () => {
    for (const [foreground, background] of emailContrastPairs) {
      expect(
        contrast(emailColors[foreground], emailColors[background]),
        `${foreground} on ${background}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("never uses dark-mode selectors or media queries and sets explicit colors", async () => {
    for (const [name, email] of await allEmails()) {
      expect(email.html, name).not.toMatch(/dark:|prefers-color-scheme|@media/i);
      expect(email.html, name).toContain('content="light only"');
      expect(email.html, name).toContain(`background-color:${emailColors.page}`);
      expect(email.html, name).toContain(`background-color:${emailColors.surface}`);
      expect(email.text.trim().length, name).toBeGreaterThan(0);
    }
  });
});

describe("OTP emails", () => {
  it("keeps the code out of the subject and inbox preview, and shows it in both bodies", async () => {
    for (const purpose of otpPurposes) {
      const email = await renderOtpEmail({ purpose, code, expiresInMinutes: 10 });
      expect(email.subject).not.toContain(code);
      const preview = /data-skip-in-text="true">([^<]*)/.exec(email.html)?.[1] ?? "";
      expect(preview.length).toBeGreaterThan(0);
      expect(preview).not.toContain(code);
      expect(/<title>([^<]*)<\/title>/.exec(email.html)?.[1]).not.toContain(code);
      expect(email.html).toContain(`>${code}</p>`);
      expect(email.text).toContain(`\n${code}\n`);
      expect(email.sender).toBe("security");
      expect(email.otp).toBe(code);
      expect(hrefs(email.html)).toEqual([]);
    }
  });

  it("gives each purpose its own subject and wording", async () => {
    const emails = await Promise.all(
      otpPurposes.map((purpose) => renderOtpEmail({ purpose, code, expiresInMinutes: 10 })),
    );
    expect(new Set(emails.map((email) => email.subject)).size).toBe(otpPurposes.length);
    expect(new Set(emails.map((email) => email.template)).size).toBe(otpPurposes.length);
  });

  it("states that signup verification does not grant beta access", async () => {
    const email = await renderOtpEmail({ purpose: "signup", code, expiresInMinutes: 10 });
    expect(email.text).toContain(
      "Verify your email to continue. App access still requires a beta invite.",
    );
  });

  it("states the Vault reset purpose distinctly", async () => {
    const reset = await renderOtpEmail({ purpose: "vault_reset", code, expiresInMinutes: 10 });
    const login = await renderOtpEmail({ purpose: "login", code, expiresInMinutes: 10 });
    expect(reset.text).toMatch(/reset your vault key/i);
    expect(reset.text).toContain("authorizes changing the key that unlocks your vault");
    expect(login.text).not.toMatch(/vault/i);
  });

  it("states that the account deletion code is permanent", async () => {
    const email = await renderOtpEmail({ purpose: "account_delete", code, expiresInMinutes: 10 });
    expect(email.text).toContain("It can't be undone.");
    expect(email.text).toContain("Your account won't be deleted without this code.");
  });

  it("uses the configured expiry phrase", async () => {
    const one = await renderOtpEmail({ purpose: "login", code, expiresInMinutes: 1 });
    const fifteen = await renderOtpEmail({ purpose: "login", code, expiresInMinutes: 15 });
    expect(one.text).toContain("This code expires in 1 minute.");
    expect(fifteen.text).toContain("This code expires in 15 minutes.");
  });

  it.each([
    ["letters", { code: "12ab56" }],
    ["too short", { code: "123" }],
    ["markup", { code: "<b>1</b>" }],
    ["zero expiry", { expiresInMinutes: 0 }],
    ["fractional expiry", { expiresInMinutes: 2.5 }],
    ["unknown purpose", { purpose: "admin" as OtpPurpose }],
  ])("rejects invalid input: %s", async (_label, override) => {
    await expect(
      renderOtpEmail({ purpose: "login", code, expiresInMinutes: 10, ...override }),
    ).rejects.toBeInstanceOf(EmailValidationError);
  });
});

describe("Vault key reset notification", () => {
  it("reports the change, links only to the configured help destination and carries no secrets", async () => {
    const email = await renderer.vaultResetNotice({ changedAt: dueAt, timeZone: "UTC" });
    expect(email.sender).toBe("security");
    expect(email.otp).toBeUndefined();
    expect(hrefs(email.html)).toEqual(["https://symplist.example/help/account"]);
    expect(email.text).toContain("Friday, September 18, 2026 at 5:00 PM (UTC)");
    expect(email.text).not.toMatch(/recovery key|token|\b\d{6}\b/i);
  });

  it("rejects an unknown time zone", async () => {
    await expect(
      renderer.vaultResetNotice({ changedAt: dueAt, timeZone: "Mars/Olympus_Mons" }),
    ).rejects.toBeInstanceOf(EmailValidationError);
  });
});

describe("reminder emails", () => {
  it("is generic by default: no title, only the task and preferences links", async () => {
    const title = "Refresh my portfolio";
    const email = await renderer.reminder(reminderBase);
    expect(email.subject).toBe("You have a task reminder");
    expect(email.sender).toBe("reminders");
    expect(email.html).not.toContain(title);
    expect(email.text).toContain(
      "Due Friday, September 18, 2026 at 10:00 AM (America/Los_Angeles).",
    );
    expect(hrefs(email.html)).toEqual([taskUrl, preferencesUrl]);
    expect(email.text).toContain(`<${taskUrl}>`);
    expect(email.text).toContain("Opening the task doesn't change it.");
    expect(email.text).toContain(
      "Turning off reminder emails doesn't stop sign-in or security emails.",
    );
    expect(email.headers).toBeUndefined();
  });

  it("includes the title only in the explicit preview variant, escaped", async () => {
    const email = await renderer.reminder({
      ...reminderBase,
      preview: { kind: "title", title: 'Pay <script>alert("x")</script>\n\tthe  rent' },
    });
    expect(email.subject).toBe('Reminder: Pay <script>alert("x")</script> the rent');
    expect(email.html).not.toContain("<script>");
    expect(email.html).toContain("Pay &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; the rent");
  });

  it("removes bidirectional overrides and zero-width spaces but keeps emoji sequences", async () => {
    const email = await renderer.reminder({
      ...reminderBase,
      preview: { kind: "title", title: "Pay \u202Etnuocca\u202C bill\u200B now 👩\u200D💻" },
    });
    expect(email.subject).toBe("Reminder: Pay tnuocca bill now 👩\u200D💻");
  });

  it("bounds long titles", async () => {
    const email = await renderer.reminder({
      ...reminderBase,
      preview: { kind: "title", title: "a".repeat(500) },
    });
    expect(Array.from(email.subject.replace("Reminder: ", ""))).toHaveLength(120);
    expect(email.subject.endsWith("…")).toBe(true);
  });

  it("uses delayed wording in the subject and body when the occurrence is late", async () => {
    const generic = await renderer.reminder({
      ...reminderBase,
      delayed: { intendedAt, timeZone: "America/Los_Angeles" },
    });
    const titled = await renderer.reminder({
      ...reminderBase,
      preview: { kind: "title", title: "Book a bike tune-up" },
      delayed: { intendedAt, timeZone: "America/Los_Angeles" },
    });
    expect(generic.subject).toBe("You have a delayed task reminder");
    expect(titled.subject).toBe("Delayed reminder: Book a bike tune-up");
    expect(generic.text).toContain(
      "This reminder was scheduled for Friday, September 18, 2026 at 9:00 AM",
    );
    expect(generic.text).toContain("and is arriving late.");
  });

  it("describes date-only deadlines and reminders without a deadline", async () => {
    const dateOnly = await renderer.reminder({
      ...reminderBase,
      due: { kind: "date", date: "2026-02-28", timeZone: "Europe/London" },
    });
    const none = await renderer.reminder({ ...reminderBase, due: { kind: "none" } });
    expect(dateOnly.text).toContain("Due Saturday, February 28, 2026 (Europe/London).");
    expect(none.text).toContain("This is a reminder you scheduled for a task.");
  });

  it("adds one-click opt-out headers only for the narrow opt-out link", async () => {
    const email = await renderer.reminder({
      ...reminderBase,
      preferencesUrl: oneClickUrl,
      oneClickUnsubscribeUrl: oneClickUrl,
    });
    expect(email.headers).toEqual({
      "List-Unsubscribe": `<${oneClickUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
    expect(hrefs(email.html)).toEqual([taskUrl, oneClickUrl]);
  });

  it.each([
    ["another origin", { openTaskUrl: "https://evil.example/now/1" }],
    ["a query string that could carry a token", { openTaskUrl: `${taskUrl}?token=abc` }],
    ["a fragment", { openTaskUrl: `${taskUrl}#complete` }],
    ["credentials", { openTaskUrl: "https://user:pass@app.symplist.example/now/1" }],
    ["plain http", { openTaskUrl: "http://app.symplist.example/now/1" }],
    ["a relative URL", { openTaskUrl: "/now/1" }],
    ["a javascript URL", { openTaskUrl: "javascript:alert(1)" }],
    ["preferences on another origin", { preferencesUrl: "https://evil.example/prefs" }],
    ["opt-out on another origin", { oneClickUnsubscribeUrl: "https://evil.example/u?token=1" }],
    ["an invalid date", { due: { kind: "date", date: "2026-02-30", timeZone: "UTC" } }],
    ["a bad zone", { due: { kind: "timed", at: dueAt, timeZone: "Nowhere/City" } }],
    ["a negative instant", { due: { kind: "timed", at: -1, timeZone: "UTC" } }],
    ["an empty title", { preview: { kind: "title", title: " \n\t " } }],
  ] as Array<[string, Partial<ReminderEmailInput>]>)("rejects %s", async (_label, override) => {
    await expect(renderer.reminder({ ...reminderBase, ...override })).rejects.toBeInstanceOf(
      EmailValidationError,
    );
  });

  it("allows loopback http origins for local development", async () => {
    const local = createEmailRenderer({
      webOrigin: "http://localhost:3000",
      apiOrigin: "http://localhost:4000",
      accountHelpUrl: "http://localhost:3000/settings/account",
    });
    const email = await local.reminder({
      ...reminderBase,
      openTaskUrl: "http://localhost:3000/now/1",
      preferencesUrl: "http://localhost:4000/v1/reminders/unsubscribe?token=fictional",
    });
    expect(hrefs(email.html)).toEqual([
      "http://localhost:3000/now/1",
      "http://localhost:4000/v1/reminders/unsubscribe?token=fictional",
    ]);
  });
});

describe("link configuration", () => {
  it.each([
    ["an origin with a path", { webOrigin: "https://app.symplist.example/app" }],
    ["plain http", { apiOrigin: "http://api.symplist.example" }],
    ["a help URL with a query", { accountHelpUrl: "https://symplist.example/help?token=1" }],
    ["a help URL with credentials", { accountHelpUrl: "https://a:b@symplist.example/help" }],
    ["a non-URL", { webOrigin: "app.symplist.example" }],
  ])("rejects %s", (_label, override) => {
    expect(() =>
      createEmailRenderer({
        webOrigin: "https://app.symplist.example",
        apiOrigin: "https://api.symplist.example",
        accountHelpUrl: "https://symplist.example/help/account",
        ...override,
      }),
    ).toThrow(EmailConfigurationError);
  });
});

describe("toEmailMessage", () => {
  it("addresses a rendered email without changing its content", async () => {
    const rendered = await renderOtpEmail({ purpose: "login", code, expiresInMinutes: 10 });
    const message = toEmailMessage(rendered, {
      to: "maya@example.com",
      idempotencyKey: "otp/login/0192f0a0-0000-7000-8000-000000000001",
    });
    expect(message).toEqual({
      to: "maya@example.com",
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      sender: "security",
      idempotencyKey: "otp/login/0192f0a0-0000-7000-8000-000000000001",
      template: "otp_sign_in",
      otp: code,
    });
  });
});
