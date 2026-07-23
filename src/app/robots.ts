import type { MetadataRoute } from "next";

// Keeps leaked capability URLs out of search engines (PRD §8) — the realistic
// exposure vector for unguessable links. Default-deny so new capability routes
// (e.g. /f/, /s/, /v/) stay out of indexes without needing this list updated;
// only the intentionally-public pages are allowlisted.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: ["/$", "/login"], disallow: "/" }],
  };
}
