import type { MetadataRoute } from "next";

/**
 * The installable app manifest (§10.3). `icon-maskable-512.png` is a separate file from
 * `icon-512.png` rather than the same one reused: Android crops a maskable icon to its own shape,
 * so that variant shrinks the mark into the centre 80% safe zone and bleeds the ground to the edge.
 * Reusing the standard icon would clip the outer dots of the mark.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Symplist",
    short_name: "Symplist",
    description: "A calm task workspace. Every task has a page and a conversation.",
    start_url: "/",
    display: "standalone",
    // Matches the mark's ground so the splash screen does not flash a different colour.
    background_color: "#1A1917",
    theme_color: "#1A1917",
    icons: [
      { src: "/brand/icon.svg", type: "image/svg+xml", sizes: "any", purpose: "any" },
      { src: "/brand/icon-512.png", type: "image/png", sizes: "512x512", purpose: "any" },
      {
        src: "/brand/icon-maskable-512.png",
        type: "image/png",
        sizes: "512x512",
        purpose: "maskable",
      },
    ],
  };
}
