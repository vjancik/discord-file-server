import { unlink } from "node:fs/promises";
import { runTool } from "../run-tool";

/**
 * Two passes, because exiftool's PDF writing is incremental-update based: it
 * appends a section marking Info/XMP deleted while the original bytes remain
 * recoverable in the file. The qpdf rewrite then drops every unreferenced
 * object (and linearizes), making the removal permanent.
 *
 * The intermediate lives next to `dest` (storage, not staging — staging space
 * is reserved byte-for-byte and must not be doubled). Password-protected PDFs
 * fail the exiftool pass and reject the upload; the user can disable document
 * cleaning to upload them as-is.
 */
export async function stripPdf(src: string, dest: string): Promise<void> {
  const tmp = `${dest}.exif.pdf`;
  try {
    await runTool(["exiftool", "-quiet", "-all=", "-o", tmp, src]);
    // qpdf exit 3 = success with warnings (e.g. minor structural repairs).
    await runTool(["qpdf", "--linearize", tmp, dest], { okCodes: [0, 3] });
  } finally {
    await unlink(tmp).catch(() => {});
  }
}
