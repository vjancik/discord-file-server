import { beforeEach, expect, mock, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const deleteFileAction = mock(
  async (_fileId: string): Promise<{ error?: string }> => ({}),
);
const setSkipDeleteConfirmAction = mock(async (_skip: boolean) => {});

mock.module("@/app/(app)/files/actions", () => ({
  deleteFileAction,
  setSkipDeleteConfirmAction,
}));

const { DeleteFileButton } = await import("./delete-file-button");

beforeEach(() => {
  deleteFileAction.mockClear();
  setSkipDeleteConfirmAction.mockClear();
});

test("skipConfirm: deletes immediately without a dialog", async () => {
  render(
    <DeleteFileButton fileId="f1" fileName="clip.mp4" skipConfirm={true} />,
  );

  await userEvent.click(
    screen.getByRole("button", { name: /delete clip\.mp4/i }),
  );

  expect(deleteFileAction).toHaveBeenCalledWith("f1");
  expect(screen.queryByText(/delete file\?/i)).toBeNull();
});

test("asks for confirmation and cancel does not delete", async () => {
  render(
    <DeleteFileButton fileId="f1" fileName="clip.mp4" skipConfirm={false} />,
  );

  await userEvent.click(
    screen.getByRole("button", { name: /delete clip\.mp4/i }),
  );
  expect(screen.getByText(/delete file\?/i)).toBeTruthy();
  expect(deleteFileAction).not.toHaveBeenCalled();

  await userEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
  expect(deleteFileAction).not.toHaveBeenCalled();
});

test("confirming deletes the file", async () => {
  render(
    <DeleteFileButton fileId="f2" fileName="song.mp3" skipConfirm={false} />,
  );

  await userEvent.click(
    screen.getByRole("button", { name: /delete song\.mp3/i }),
  );
  await userEvent.click(screen.getByRole("button", { name: /^delete$/i }));

  expect(deleteFileAction).toHaveBeenCalledWith("f2");
  expect(setSkipDeleteConfirmAction).not.toHaveBeenCalled();
});

test("'don't show this again' persists the global opt-out on confirm", async () => {
  render(
    <DeleteFileButton fileId="f3" fileName="doc.pdf" skipConfirm={false} />,
  );

  await userEvent.click(
    screen.getByRole("button", { name: /delete doc\.pdf/i }),
  );
  await userEvent.click(
    screen.getByRole("checkbox", { name: /don't show this again/i }),
  );
  await userEvent.click(screen.getByRole("button", { name: /^delete$/i }));

  expect(deleteFileAction).toHaveBeenCalledWith("f3");
  expect(setSkipDeleteConfirmAction).toHaveBeenCalledWith(true);
});
