import type { MetadataRoute } from "next";
import { SITE_URL } from "@/features/marketing/site-chrome";

/** Only the pages a signed-out visitor can actually read; everything else needs a session. */
export default function sitemap(): MetadataRoute.Sitemap {
  const updated = new Date("2026-10-01");
  return [
    { url: SITE_URL, lastModified: updated, changeFrequency: "monthly", priority: 1 },
    { url: `${SITE_URL}/privacy`, lastModified: updated, changeFrequency: "yearly", priority: 0.4 },
    { url: `${SITE_URL}/terms`, lastModified: updated, changeFrequency: "yearly", priority: 0.4 },
    { url: `${SITE_URL}/cookies`, lastModified: updated, changeFrequency: "yearly", priority: 0.3 },
  ];
}
