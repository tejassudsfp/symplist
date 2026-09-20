import type { ReactNode } from "react";
import { Body, Container, Head, Hr, Html, Preview, Section, Text } from "react-email";
import { styles } from "./theme.ts";

export interface EmailLayoutProps {
  /** Inbox preview text. Never contains codes, titles or other sensitive content. */
  readonly preview: string;
  readonly children: ReactNode;
  /** Footer lines specific to the email, rendered above the attribution. */
  readonly footer: ReactNode;
}

/** Shared frame: brand line, content, footer and a restrained open-source attribution. */
export function EmailLayout({ preview, children, footer }: EmailLayoutProps) {
  return (
    <Html lang="en" dir="ltr">
      <Head>
        <meta name="color-scheme" content="light only" />
        <meta name="supported-color-schemes" content="light" />
      </Head>
      <Body style={styles.body}>
        <Preview>{preview}</Preview>
        <Container style={styles.container}>
          <Text style={styles.brand}>symplist</Text>
          {children}
          <Hr style={styles.rule} />
          <Section>
            {footer}
            <Text style={styles.footer}>
              symplist is open source under the MIT License, made by Tejas Parthasarathi Sudarshan
              (tejassuds.com).
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}
