import type { MetadataRoute } from "next";
import { SITE_URL } from "@/features/marketing/site-chrome";

/**
 * What a crawler may read: the public site, and nothing behind sign-in.
 *
 * The workspace routes are disallowed rather than left to the session redirect. A crawler that follows
 * `/now` gets the sign-in page, which would put a sign-in form in search results for a product whose
 * homepage is the thing people should find.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: [
        "/now",
        "/later",
        "/unclassified",
        "/tasks/",
        "/archive",
        "/calendar",
        "/settings/",
        "/vault",
        "/admin/",
        "/signin",
        "/welcome",
        "/access",
        "/oauth/",
        "/artifact/",
      ],
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
