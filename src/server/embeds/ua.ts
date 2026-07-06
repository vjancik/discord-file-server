/**
 * UA sniffing for the /s/ short-link route (PRD §5, the InstaFix trick):
 * embed crawlers get an OG-tagged HTML page, humans get a 302 to the file.
 * Discord is the product target; the other crawlers get the same treatment so
 * links pasted elsewhere degrade gracefully.
 */
const CRAWLER_PATTERN =
  /discordbot|twitterbot|telegrambot|slackbot|whatsapp|facebookexternalhit/i;

export function isEmbedCrawler(userAgent: string | null): boolean {
  return userAgent !== null && CRAWLER_PATTERN.test(userAgent);
}
