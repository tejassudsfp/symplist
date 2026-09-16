"use client";

import { createContext, type ReactNode, useContext, useMemo } from "react";
import { getApiClient } from "@/lib/api";
import { createSearchApi, type SearchApi } from "./api.ts";

/**
 * The shared browser client, resolved when a call is made rather than when a surface renders: the
 * full search screen is server-rendered first, where the API client refuses to exist (§5.1).
 */
function browserSearchApi(): SearchApi {
  const api = () => createSearchApi(getApiClient());
  return {
    titles: (q, options, signal) => api().titles(q, options, signal),
    content: (request, signal) => api().content(request, signal),
    freshness: (signal) => api().freshness(signal),
    recentTasks: (signal) => api().recentTasks(signal),
    locateTask: (taskId, signal) => api().locateTask(taskId, signal),
  };
}

/**
 * The search calls every surface uses. The app builds them over the shared browser API client;
 * tests and previews pass their own so nothing reaches the network.
 */
const SearchApiContext = createContext<SearchApi | null>(null);

export function SearchApiProvider({
  api,
  children,
}: {
  readonly api: SearchApi;
  readonly children: ReactNode;
}) {
  return <SearchApiContext.Provider value={api}>{children}</SearchApiContext.Provider>;
}

export function useSearchApi(): SearchApi {
  const provided = useContext(SearchApiContext);
  // The default client reads the public API origin; it is built once, on first use in the browser.
  return useMemo(() => provided ?? browserSearchApi(), [provided]);
}
