"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

/**
 * One query parameter of the current address, read on the client. Entry screens use this instead of
 * `useSearchParams` so they need no Suspense boundary and never render the value on the server.
 */
export function useQueryParam(name: string): string | null {
  const pathname = usePathname();
  const [value, setValue] = useState<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the pathname is what marks a navigation, after which the query may differ.
  useEffect(() => {
    setValue(new URLSearchParams(window.location.search).get(name));
  }, [name, pathname]);
  return value;
}
