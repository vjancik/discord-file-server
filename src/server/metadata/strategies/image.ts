import { runTool } from "../run-tool";

/**
 * exiftool rewrite minus all metadata: image data is copied verbatim (no
 * re-encode). Two functional exceptions survive the wipe:
 *  - Orientation, or phone photos display sideways (`-tagsfromfile @` copies
 *    it back from the source after `-all=` cleared it);
 *  - the ICC profile (`--icc_profile:all` excludes it from deletion), or
 *    wide-gamut images shift colors.
 * GPS, timestamps, device/serial and XMP all go.
 */
export async function stripImage(src: string, dest: string): Promise<void> {
  await runTool([
    "exiftool",
    "-quiet",
    "-all=",
    "--icc_profile:all",
    "-tagsfromfile",
    "@",
    "-Orientation",
    "-o",
    dest,
    src,
  ]);
}
