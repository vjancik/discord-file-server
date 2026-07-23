import { expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { FileView } from "@/lib/file-view";
import { PreviewDialog } from "./preview-dialog";

function fileView(overrides: Partial<FileView> = {}): FileView {
  return {
    id: "abc",
    fileName: "clip.mp4",
    kind: "video",
    mimeType: "video/mp4",
    sizeBytes: 2_500_000,
    status: "approved",
    createdAt: "2026-06-01T12:00:00.000Z",
    shortUrl: "http://localhost/s/code1234",
    canonicalUrl: "http://localhost/f/abc/clip.mp4",
    thumbnailUrl: null,
    width: 1280,
    height: 720,
    deletedAt: null,
    ...overrides,
  };
}

const embed = {
  title: "A Source Video",
  description: "line one\n\nline two",
  sourceUrl: "https://example.com/watch?v=1",
  viewCount: 1_299_168,
  uploadedAt: "2026-05-21T00:00:00.000Z",
  watchUrl: "http://localhost/v/code1234",
};

test("plain files get the media preview without a Full View link", async () => {
  render(<PreviewDialog file={fileView()} />);

  await userEvent.click(
    screen.getByRole("button", { name: /preview clip\.mp4/i }),
  );

  expect(screen.getByText("clip.mp4")).toBeTruthy();
  expect(screen.queryByRole("link", { name: /full view/i })).toBeNull();
  expect(screen.queryByText("A Source Video")).toBeNull();
});

test("embed files get the watch view and a Full View link", async () => {
  render(<PreviewDialog file={fileView({ embed })} />);

  await userEvent.click(
    screen.getByRole("button", { name: /preview clip\.mp4/i }),
  );

  const fullView = screen.getByRole("link", {
    name: /full view/i,
  }) as HTMLAnchorElement;
  expect(fullView.href).toBe("http://localhost/v/code1234");

  // Shared WatchView content: source title, stats line, description, links.
  expect(screen.getByText("A Source Video")).toBeTruthy();
  expect(screen.getByText("1,299,168 views · May 21, 2026")).toBeTruthy();
  expect(screen.getByText(/line one/)).toBeTruthy();
  const original = screen.getByRole("link", {
    name: /original url/i,
  }) as HTMLAnchorElement;
  expect(original.href).toBe("https://example.com/watch?v=1");
  const download = screen.getByRole("link", {
    name: /^download$/i,
  }) as HTMLAnchorElement;
  expect(download.getAttribute("download")).toBe("clip.mp4");
});
