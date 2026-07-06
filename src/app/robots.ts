import type { MetadataRoute } from "next";

// Keeps leaked capability URLs out of search engines (PRD §8) — the realistic
// exposure vector for unguessable links.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", disallow: ["/f/", "/s/"] }],
  };
}
