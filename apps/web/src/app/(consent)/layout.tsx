import type { ReactNode } from "react";

/** OAuth consent for incoming MCP clients. Analytics never loads here (§14.5, §15). */
export default function ConsentLayout({ children }: { children: ReactNode }) {
  return children;
}
