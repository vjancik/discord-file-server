/**
 * Default executable blocklist (PRD §5). Shared module: the server enforces it
 * (type-policy) and the upload page uses it for immediate client-side feedback.
 */
export const BLOCKED_EXTENSIONS: ReadonlySet<string> = new Set([
  "exe",
  "msi",
  "bat",
  "cmd",
  "com",
  "scr",
  "ps1",
  "vbs",
  "vbe",
  "lnk",
  "sh",
  "bash",
  "zsh",
  "apk",
  "ipa",
  "app",
  "dmg",
  "pkg",
  "deb",
  "rpm",
  "jar",
  "msix",
  "appx",
  "elf",
  "bin",
  "run",
]);

export function extensionOf(fileName: string): string {
  const idx = fileName.lastIndexOf(".");
  if (idx <= 0 || idx === fileName.length - 1) return "";
  return fileName.slice(idx + 1).toLowerCase();
}

export function isBlockedExtension(fileName: string): boolean {
  return BLOCKED_EXTENSIONS.has(extensionOf(fileName));
}
