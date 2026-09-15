import type { ReactNode } from "react";

/** Beta access gate and paused access. Analytics never loads here (§15). */
export default function GateLayout({ children }: { children: ReactNode }) {
  return children;
}
