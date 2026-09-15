import { Heading, Section, Text } from "react-email";
import { EmailLayout } from "./layout.tsx";
import { styles } from "./theme.ts";

/** OTP purposes (§5.1). Each purpose has its own wording so a code is never mistaken for another. */
export type OtpPurpose = "login" | "signup" | "vault_reset" | "account_delete";

export const otpPurposes: readonly OtpPurpose[] = [
  "login",
  "signup",
  "vault_reset",
  "account_delete",
];

export interface OtpEmailProps {
  readonly purpose: OtpPurpose;
  /** The digits of the one-time code. */
  readonly code: string;
  /** Minutes until the code expires (`OTP_TTL_MINUTES`). */
  readonly expiresInMinutes: number;
}

interface OtpCopy {
  readonly subject: string;
  readonly preview: string;
  readonly heading: string;
  readonly intro: readonly string[];
  readonly ignore: string;
}

export function expiryPhrase(minutes: number): string {
  return `This code expires in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`;
}

export function otpCopy(purpose: OtpPurpose, expiresInMinutes: number): OtpCopy {
  const expiry = expiryPhrase(expiresInMinutes);
  switch (purpose) {
    case "login":
      return {
        subject: "Your symplist sign-in code",
        preview: `Use this code to sign in to symplist. ${expiry}`,
        heading: "Sign in to symplist",
        intro: ["Enter this code to sign in."],
        ignore: "If you didn't try to sign in, you can ignore this email.",
      };
    case "signup":
      return {
        subject: "Verify your email for symplist",
        preview: `Verify your email to continue. ${expiry}`,
        heading: "Verify your email",
        intro: [
          "Verify your email to continue. App access still requires a beta invite.",
          "Enter this code to confirm this address belongs to you.",
        ],
        ignore: "If you didn't try to create a symplist account, you can ignore this email.",
      };
    case "vault_reset":
      return {
        subject: "Your symplist vault reset code",
        preview: `Use this code to reset your vault key. ${expiry}`,
        heading: "Reset your vault key",
        intro: [
          "Enter this code to reset your vault key. It authorizes changing the key that unlocks your vault; your vault items are kept.",
        ],
        ignore:
          "If you didn't ask to reset your vault key, you can ignore this email. Your vault key stays the same.",
      };
    case "account_delete":
      return {
        subject: "Confirm deleting your symplist account",
        preview: `Use this code to confirm deleting your account. ${expiry}`,
        heading: "Confirm account deletion",
        intro: [
          "Enter this code to confirm that you want to delete your symplist account.",
          "Deleting your account permanently removes your tasks, documents, chats and vault. It can't be undone.",
        ],
        ignore:
          "If you didn't ask to delete your account, you can ignore this email. Your account won't be deleted without this code.",
      };
  }
}

/** OTP email for sign-in, signup verification, Vault reset or account deletion (§5.1, §5.6, §11.2). */
export function OtpEmail({ purpose, code, expiresInMinutes }: OtpEmailProps) {
  const copy = otpCopy(purpose, expiresInMinutes);
  return (
    <EmailLayout
      preview={copy.preview}
      footer={
        <Text style={styles.footer}>
          This is a security email from symplist. Reminder email settings never turn it off.
        </Text>
      }
    >
      <Heading as="h1" style={styles.heading}>
        {copy.heading}
      </Heading>
      {copy.intro.map((line) => (
        <Text key={line} style={styles.paragraph}>
          {line}
        </Text>
      ))}
      <Section style={styles.codeBox}>
        <Text style={styles.code}>{code}</Text>
      </Section>
      <Text style={styles.paragraph}>{expiryPhrase(expiresInMinutes)}</Text>
      <Text style={styles.muted}>Never share this code. symplist will never ask you for it.</Text>
      <Text style={styles.muted}>{copy.ignore}</Text>
    </EmailLayout>
  );
}
