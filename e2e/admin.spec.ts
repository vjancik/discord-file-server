import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { fakeMp4Bytes, signUpAndIn } from "./helpers";

test("admin sees the review queue and can approve a pending file", async ({
  browser,
}) => {
  // A regular user uploads a file (lands in the queue as `pending`)
  const userContext = await browser.newContext();
  const userPage = await userContext.newPage();
  await signUpAndIn(userPage);
  await userPage.goto("/");
  await userPage
    .locator('.uppy-Dashboard input[type="file"]')
    .first()
    .setInputFiles({
      name: "review me.mp4",
      mimeType: "video/mp4",
      buffer: fakeMp4Bytes(),
    });
  await userPage.getByRole("button", { name: /upload/i }).click();
  await expect(userPage.locator("code", { hasText: "/s/" })).toBeVisible({
    timeout: 30_000,
  });
  await userContext.close();

  // An admin (user with a linked Discord account listed in ADMIN_DISCORD_IDS)
  const adminContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  const { email } = await signUpAndIn(adminPage);
  execFileSync(
    "bun",
    ["scripts/e2e-make-admin.ts", email, "e2e-admin-discord-id"],
    {
      env: { ...process.env, DATABASE_PATH: "./.data/e2e/db.sqlite" },
    },
  );

  await adminPage.goto("/admin/review");
  await expect(
    adminPage.getByRole("heading", { name: /review queue/i }),
  ).toBeVisible();
  await expect(adminPage.getByText("review me.mp4").first()).toBeVisible();

  await adminPage.getByRole("button", { name: /^approve$/i }).click();
  await expect(adminPage.getByText(/nothing pending review/i)).toBeVisible();

  // Approved file shows up in the global browser
  await adminPage.goto("/admin/files");
  await expect(adminPage.getByText("review me.mp4")).toBeVisible();
  await expect(adminPage.getByText("approved").first()).toBeVisible();

  // Sorting must not wedge the page in a render loop: after clicking sort
  // headers the main thread must stay responsive and React must not report
  // an update-depth blowup.
  const consoleErrors: string[] = [];
  adminPage.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  await adminPage.getByRole("button", { name: /uploaded/i }).click();
  await adminPage.getByRole("button", { name: /^name$/i }).click();
  await expect
    .poll(() => adminPage.evaluate(() => 1 + 1), { timeout: 5_000 })
    .toBe(2);
  expect(consoleErrors.filter((e) => /maximum update depth/i.test(e))).toEqual(
    [],
  );
  await adminContext.close();
});

test("non-admins get a 404 on admin routes", async ({ page }) => {
  await signUpAndIn(page);
  const res = await page.goto("/admin/review");
  expect(res?.status()).toBe(404);
});
