import { expect, mock, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import type { FileView } from "@/lib/file-view";

mock.module("@/app/(app)/files/actions", () => ({
  deleteFileAction: mock(async () => ({})),
  setSkipDeleteConfirmAction: mock(async () => {}),
}));

const { FilesTable } = await import("./files-table");

function fileView(overrides: Partial<FileView> = {}): FileView {
  return {
    id: "abc",
    fileName: "clip.mp4",
    kind: "video",
    mimeType: "video/mp4",
    sizeBytes: 2_500_000,
    status: "pending",
    createdAt: "2026-06-01T12:00:00.000Z",
    shortUrl: "http://localhost/s/code1234",
    canonicalUrl: "http://localhost/f/abc/clip.mp4",
    thumbnailUrl: null,
    deletedAt: null,
    ...overrides,
  };
}

test("shows an empty state when there are no files", () => {
  render(<FilesTable files={[]} skipConfirm={false} />);
  expect(screen.getByText(/no files yet/i)).toBeTruthy();
});

test("renders rows with name, size, status, and actions", () => {
  render(
    <FilesTable
      files={[
        fileView(),
        fileView({
          id: "def",
          fileName: "photo.png",
          kind: "image",
          status: "approved",
          sizeBytes: 512,
        }),
      ]}
      skipConfirm={false}
    />,
  );

  expect(screen.getByText("clip.mp4")).toBeTruthy();
  expect(screen.getByText("photo.png")).toBeTruthy();
  expect(screen.getByText("2.5 MB")).toBeTruthy();
  expect(screen.getByText("pending")).toBeTruthy();
  expect(screen.getByText("approved")).toBeTruthy();
  expect(
    screen.getByRole("button", { name: /delete clip\.mp4/i }),
  ).toBeTruthy();
  expect(
    screen.getByRole("button", { name: /preview photo\.png/i }),
  ).toBeTruthy();

  const download = screen.getByRole("link", {
    name: /download clip\.mp4/i,
  }) as HTMLAnchorElement;
  expect(download.href).toBe("http://localhost/f/abc/clip.mp4");
  expect(download.getAttribute("download")).toBe("clip.mp4");
});
