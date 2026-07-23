import { expect, mock, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CopyButton } from "./copy-button";

test("copies the value to the clipboard on click", async () => {
  const writeText = mock(async (_text: string) => {});
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });

  render(
    <CopyButton value="https://files.example.com/s/abc123" label="Copy link" />,
  );
  await userEvent.click(screen.getByRole("button", { name: /copy link/i }));

  expect(writeText).toHaveBeenCalledWith("https://files.example.com/s/abc123");
});

test("falls back to execCommand when the clipboard API is unavailable", async () => {
  Object.defineProperty(navigator, "clipboard", {
    value: undefined,
    configurable: true,
  });
  const execCommand = mock((_cmd: string) => true);
  (document as unknown as { execCommand: typeof execCommand }).execCommand =
    execCommand;

  render(<CopyButton value="fallback-text" />);
  await userEvent.click(screen.getByRole("button", { name: /copy/i }));

  expect(execCommand).toHaveBeenCalledWith("copy");
});
