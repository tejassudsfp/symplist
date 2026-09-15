import { Heading, Link, Text } from "react-email";
import { formatInstant } from "./format.ts";
import { EmailLayout } from "./layout.tsx";
import { styles } from "./theme.ts";

export interface VaultResetNoticeEmailProps {
  /** When the new vault key was committed, UTC epoch milliseconds. */
  readonly changedAt: number;
  /** The account's notification time zone, used to show `changedAt`. */
  readonly timeZone: string;
  /** The configured account and help destination; never a reset capability. */
  readonly accountHelpUrl: string;
}

export const vaultResetNoticeSubject = "Your symplist vault key was changed";

/**
 * Sent after a completed Vault reset (§11.2). It reports the change and links to the configured
 * help destination. It never includes vault values, recovery keys or reset links.
 */
export function VaultResetNoticeEmail({
  changedAt,
  timeZone,
  accountHelpUrl,
}: VaultResetNoticeEmailProps) {
  const when = formatInstant(changedAt, timeZone, "changedAt");
  return (
    <EmailLayout
      preview="The key that unlocks your symplist vault was changed."
      footer={
        <Text style={styles.footer}>
          This is a security email from symplist. Reminder email settings never turn it off.
        </Text>
      }
    >
      <Heading as="h1" style={styles.heading}>
        Your vault key was changed
      </Heading>
      <Text style={styles.paragraph}>
        The key that unlocks your symplist vault was reset on {when}.
      </Text>
      <Text style={styles.paragraph}>
        Your vault items were kept. Open vault sessions were locked, and vault access you had given
        Simon for tasks was turned off. You can give it again from the vault.
      </Text>
      <Text style={styles.paragraph}>
        If you didn't reset your vault key, check your account now:{" "}
        <Link href={accountHelpUrl} style={styles.link}>
          Account and help
        </Link>
        .
      </Text>
    </EmailLayout>
  );
}
