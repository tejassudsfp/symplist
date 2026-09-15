import { Button, Heading, Link, Section, Text } from "react-email";
import { EmailValidationError } from "../errors.ts";
import { formatInstant, formatPlainDate } from "./format.ts";
import { EmailLayout } from "./layout.tsx";
import { styles } from "./theme.ts";

/** What the reminder is due against (§12.1): a timed deadline, a date-only deadline or none. */
export type ReminderDue =
  | { readonly kind: "timed"; readonly at: number; readonly timeZone: string }
  | { readonly kind: "date"; readonly date: string; readonly timeZone: string }
  | { readonly kind: "none" };

/**
 * Generic by default; the task title appears only when the owner explicitly opted in to email
 * previews (note 15, email privacy). Nothing else from the task is ever included.
 */
export type ReminderPreview =
  | { readonly kind: "generic" }
  | { readonly kind: "title"; readonly title: string };

export interface ReminderEmailProps {
  readonly due: ReminderDue;
  readonly preview: ReminderPreview;
  /** Present when the occurrence is delivered late (`late = 1`, §12.3). */
  readonly delayed?: { readonly intendedAt: number; readonly timeZone: string };
  /** Authenticated app link; opening it requires sign-in and never changes the task. */
  readonly openTaskUrl: string;
  /** Reminder preferences or the narrow one-click reminder opt-out link. */
  readonly preferencesUrl: string;
}

const maxTitleLength = 120;

/** Collapses whitespace and control characters and bounds the length of an opted-in title. */
export function sanitizeReminderTitle(title: string): string {
  // Control characters, line separators, zero-width spaces and bidirectional overrides would break
  // the subject line or disguise text; joiners inside emoji sequences are kept.
  const collapsed = title
    .replace(/[\p{Cc}\p{Zl}\p{Zp}\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (collapsed === "") {
    throw new EmailValidationError(
      "email.invalid_template_input",
      "A title preview needs a non-empty title",
    );
  }
  const characters = Array.from(collapsed);
  if (characters.length <= maxTitleLength) return collapsed;
  return `${characters
    .slice(0, maxTitleLength - 1)
    .join("")
    .trimEnd()}…`;
}

export function reminderSubject(preview: ReminderPreview, delayed: boolean): string {
  if (preview.kind === "title") {
    const title = sanitizeReminderTitle(preview.title);
    return delayed ? `Delayed reminder: ${title}` : `Reminder: ${title}`;
  }
  return delayed ? "You have a delayed task reminder" : "You have a task reminder";
}

export function dueSentence(due: ReminderDue): string {
  switch (due.kind) {
    case "timed":
      return `Due ${formatInstant(due.at, due.timeZone, "due.at")}.`;
    case "date":
      return `Due ${formatPlainDate(due.date, due.timeZone)}.`;
    case "none":
      return "This is a reminder you scheduled for a task.";
  }
}

/** Task reminder email: generic or title preview, on time or delayed (§12.3). */
export function ReminderEmail({
  due,
  preview,
  delayed,
  openTaskUrl,
  preferencesUrl,
}: ReminderEmailProps) {
  const isDelayed = delayed !== undefined;
  const title = preview.kind === "title" ? sanitizeReminderTitle(preview.title) : null;
  return (
    <EmailLayout
      preview={isDelayed ? "A task reminder that is arriving late." : "You have a task reminder."}
      footer={
        <>
          <Text style={styles.footer}>
            You're getting this because email is on for this reminder.{" "}
            <Link href={preferencesUrl} style={styles.link}>
              Manage reminder emails
            </Link>
            .
          </Text>
          <Text style={styles.footer}>
            Turning off reminder emails doesn't stop sign-in or security emails.
          </Text>
        </>
      }
    >
      <Heading as="h1" style={styles.heading}>
        {isDelayed ? "You have a delayed task reminder" : "You have a task reminder"}
      </Heading>
      {title !== null ? (
        <Section style={styles.detailBox}>
          <Text style={styles.detailLabel}>Task</Text>
          <Text style={styles.detailValue}>{title}</Text>
        </Section>
      ) : null}
      <Text style={styles.paragraph}>{dueSentence(due)}</Text>
      {isDelayed ? (
        <Text style={styles.paragraph}>
          This reminder was scheduled for{" "}
          {formatInstant(delayed.intendedAt, delayed.timeZone, "delayed.intendedAt")} and is
          arriving late.
        </Text>
      ) : null}
      <Section style={{ margin: "8px 0 20px" }}>
        <Button href={openTaskUrl} style={styles.button}>
          Open task
        </Button>
      </Section>
      <Text style={styles.muted}>
        You'll be asked to sign in. Opening the task doesn't change it.
      </Text>
    </EmailLayout>
  );
}
