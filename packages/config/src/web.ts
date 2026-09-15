/**
 * Public web configuration (§16.2). Browser-safe: this entry point never imports `node:*` and only
 * describes values that are inlined into the client bundle at build time.
 */
export interface WebPublicConfig {
  NEXT_PUBLIC_API_URL: string;
  NEXT_PUBLIC_WS_URL: string;
  NEXT_PUBLIC_POSTHOG_KEY?: string;
  NEXT_PUBLIC_POSTHOG_HOST?: string;
}
