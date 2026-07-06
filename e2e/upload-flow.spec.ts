import { expect, test } from "@playwright/test";
import { DISCORDBOT_UA, fakeMp4Bytes, signUpAndIn } from "./helpers";

test("unauthenticated visitors are redirected to /login", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
  await expect(
    page.getByRole("button", { name: /sign in with discord/i }),
  ).toBeVisible();
});

test("upload → share link resolves (browser + Discordbot) → delete kills the link", async ({
  page,
}) => {
  await signUpAndIn(page);

  // Upload through the Uppy dashboard
  await page.goto("/");
  await page
    .locator('.uppy-Dashboard input[type="file"]')
    .first()
    .setInputFiles({
      name: "e2e clip.mp4",
      mimeType: "video/mp4",
      buffer: fakeMp4Bytes(),
    });
  await page.getByRole("button", { name: /upload/i }).click();

  // The finish hook hands back the short link
  const linkRow = page.locator("code", { hasText: "/s/" });
  await expect(linkRow).toBeVisible({ timeout: 30_000 });
  const shortUrl = (await linkRow.textContent())?.trim();
  expect(shortUrl).toBeTruthy();
  const shortPath = new URL(shortUrl as string).pathname;

  // Browser UA: 302 to the canonical file, which serves video/mp4 (no attachment)
  const browserRes = await page.request.get(shortPath, { maxRedirects: 0 });
  expect(browserRes.status()).toBe(302);
  const canonical = browserRes.headers().location;
  expect(canonical).toContain("/f/");
  const fileRes = await page.request.get(canonical);
  expect(fileRes.status()).toBe(200);
  expect(fileRes.headers()["content-type"]).toContain("video/mp4");
  expect(fileRes.headers()["content-disposition"]).toBeUndefined();

  // Discordbot UA: OG page with og:video pointing at the canonical URL
  const botRes = await page.request.get(shortPath, {
    headers: { "user-agent": DISCORDBOT_UA },
    maxRedirects: 0,
  });
  expect(botRes.status()).toBe(200);
  const og = await botRes.text();
  expect(og).toContain('property="og:video"');
  expect(og).toContain("e2e clip.mp4");

  // File appears in the dashboard; delete it (confirm dialog path)
  await page.goto("/files");
  await expect(page.getByText("e2e clip.mp4")).toBeVisible();
  await page.getByRole("button", { name: /delete e2e clip\.mp4/i }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /^delete$/i })
    .click();

  // Deletion kills every link immediately (PRD §8)
  await expect(page.getByText(/no files yet/i)).toBeVisible();
  const deadShort = await page.request.get(shortPath, { maxRedirects: 0 });
  expect(deadShort.status()).toBe(404);
  const deadCanonical = await page.request.get(canonical);
  expect(deadCanonical.status()).toBe(404);
});

test("executable uploads are rejected client-side", async ({ page }) => {
  await signUpAndIn(page);
  await page.goto("/");
  await page
    .locator('.uppy-Dashboard input[type="file"]')
    .first()
    .setInputFiles({
      name: "malware.exe",
      mimeType: "application/x-msdownload",
      buffer: Buffer.from("MZ fake"),
    });
  await expect(
    page.getByText(/executable files are not allowed/i).first(),
  ).toBeVisible();
});
