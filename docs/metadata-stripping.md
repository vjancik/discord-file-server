# Metadata stripping: what gets cleaned, per file type

Uploads routinely carry personally identifying metadata the uploader never
sees: GPS coordinates and device serials in phone photos and videos, the OS
account's full name in Office documents and PDFs, uid/gid and timestamps in
zip archives. Since every file here is shareable via a public short link,
finalize removes that metadata before a file is published. Implemented in
`src/server/metadata/` (orchestrator + one strategy per format family),
invoked from the finalize service; the format→strategy map lives in
`src/lib/metadata-support.ts`, shared with the upload page so the client
warning and server behavior can't drift apart.

Two per-user settings toggles control it, both **on by default** (stripping
is opt-out): one for photos/video/audio, one for documents and zip
containers. The tus finalize hook resolves them per upload from
`SettingsRepository`.

## Coverage

| Formats | How | What's removed | What's kept |
|---|---|---|---|
| Images: jpg, png, gif, webp, avif, tiff, heic/heif | exiftool rewrite (`-all=`), image data copied verbatim — no re-encode | EXIF (GPS, device, serial, timestamps), XMP, IPTC, comments | Orientation (copied back so photos don't display sideways), ICC profile (colors) |
| Video: mp4, m4v, webm, mov, mkv, avi | ffmpeg remux, stream copy — no transcode | Global container tags: GPS (`©xyz`), creation time, encoder, title/comment; data/attachment tracks (timecode, fonts) | Video/audio/subtitle streams bit-identical; rotation (display matrix is side data, not metadata); mp4-family gets `+faststart` |
| Audio: mp3, wav, ogg/oga/opus, flac, m4a, aac | same ffmpeg remux, audio streams only | ID3 / Vorbis comments / WAV `LIST`+`bext` chunks; embedded cover art (an attached picture stream that can itself carry EXIF) | The audio stream, untouched |
| PDF | exiftool `-all=`, then a **qpdf rewrite** | Info dictionary (Author, Title…) and XMP — including the recoverable history: exiftool's PDF writes are incremental-update based, so without the qpdf pass the "deleted" values remain in the file bytes | Page content, encryption params qpdf can carry over |
| Office OOXML (docx, xlsx, pptx) + ODF (odt, ods, odp) | in-house zip rewrite (fflate) | `docProps/*` / `meta.xml` (creator, lastModifiedBy, company, editing time; custom properties emptied, not deleted — dangling part references break strict consumers); author/initials attributes on tracked changes and comments; `people.xml` names and cloud userIds; the xlsx absolute save path (`C:\Users\<name>\…`); pptx comment author names; zip entry mtimes → 1980 | All document content — comment *text*, tracked-change *text*, media parts byte-identical |
| Zip archives | in-place byte patch of the container (`zip-patch.ts`) | Entry mtimes → 1980-01-01, extra-field payloads zeroed (Info-ZIP uid/gid, UT + NTFS timestamps), entry + archive comments blanked | Entry contents entirely — see below |

Everything else is delivered verbatim.

## What is intentionally not covered

- **Files inside archives.** The zip patch cleans only the container; a zip
  of photos still has EXIF inside every photo. Recursing into archives would
  mutate the user's contents (breaking checksums and signatures), so it's
  out of scope. The upload page warns about this for zip/tar/7z selections.
- **tar, tar.gz/tgz, bz2, xz, zst, 7z, rar**: not cleaned at all.
  Compressed streams can't be patched without full recompression; plain tar
  is rare enough that it wasn't worth a strategy. Warned in the UI.
- **Legacy Office (.doc/.xls/.ppt)** and other unsupported binary formats:
  no maintained tool writes OLE2 metadata; warned in the UI.
- **Document-content identity**: tracked-change and comment text, docx rsid
  fingerprints, PDF annotation authors and embedded attachments. Removing
  content is a different (destructive) operation than removing metadata.
- **bmp/svg**: exiftool can't write them (and svg is already served
  download-only for script-safety reasons); warned.

The honest summary is stored per file in the `files.metadata_status` column
(`METADATA_STATUSES` in [schema.ts](../src/db/schema.ts)), a three-state enum:

- **`stripped`** — a strategy ran and removed the metadata channel (images,
  video/audio, PDF, Office).
- **`none`** — the format has no embedded-metadata channel to begin with:
  plain text, source code, config. There is nothing to remove, so recording
  "possible" would be misleading. This is decided from the extension
  allowlist (`NO_METADATA_EXTS`) and, for unrecognized extensions, from a
  content sniff of the delivered bytes (see below).
- **`possible`** — the file may still carry PII: stripping was disabled by
  the user's toggle, the format is uncleanable (tar/7z/legacy Office/unknown
  binary), or it's a zip whose container was cleaned but whose contents were
  not.

Nothing displays it yet; it exists so a future UI badge doesn't need a
backfill. (It replaced an earlier boolean `possible_metadata`, which couldn't
tell "nothing to clean" apart from "couldn't clean".)

### Detecting text without trusting the extension

Files with an unrecognized extension aren't assumed to carry metadata. Both
the upload page and the finalize service run the same heuristic —
`looksLikeText` in [metadata-support.ts](../src/lib/metadata-support.ts), the
git/`file(1)` shape: no NUL bytes and control characters limited to
whitespace, over the first 8 KB. High bytes are allowed so UTF-8 text in any
script passes.

- **Client** (upload page): suppresses the amber "can't strip metadata"
  warning for a dropped file that sniffs as text, reading only a lazy
  `Blob.slice()` prefix so the whole file never loads. Purely cosmetic.
- **Server** (finalize): re-runs the same sniff on the bytes it received —
  never trusting the client's result — and records `metadata_status = "none"`
  for an unrecognized file that reads as text.

Blind spots are benign for this use: UTF-16/UTF-32 is NUL-heavy so it reads
as binary (→ `possible`, a false warning at worst), and a binary blob with a
NUL-free 8 KB prefix reads as text (→ `none`) — neither changes what the
strip pipeline does, since text and unknown files are delivered verbatim
either way.

## Failure policy: fail closed

If a strategy errors on a supported type — corrupt file, password-protected
PDF, missing binary — the upload is **rejected** (422 with the reason), not
published unstripped. Publishing dirty bytes would break the toggle's
promise exactly when it matters. The user-visible escape hatch is turning
the relevant toggle off, which uploads the file verbatim (recorded as
`metadata_status = "possible"`).

## Space discipline

Staging space is reserved byte-for-byte at upload creation
([capacity.md](capacity.md)), so strategies never write a second copy into
staging:

- Full strategies read from staging and write directly into the storage
  dir, to a hidden `.strip-incoming.<ext>` temp renamed onto the final path
  (Caddy serves `/f/*` straight off disk, so bytes must not be readable at
  the servable path until complete), then unlink the staging copy.
- Zip is moved into storage first, then patched **in place** — every write
  lands at a fixed offset, the file size never changes, zero extra space.
- Two transient storage-side (never staging) double-copies exist: the PDF
  chain's intermediate between the exiftool and qpdf passes, and ffmpeg's
  `+faststart` second pass on mp4-family output.

Note the DB row's `size_bytes` stays the declared upload size; the on-disk
file is marginally smaller after a strip (metadata bytes removed).

## Tooling and where it's installed

- **exiftool** (images, PDF pass 1) and **qpdf** (PDF pass 2): Debian
  packages in the web image (`Dockerfile` web stage — apt ships identical
  amd64/arm64 builds, unlike qpdf's upstream releases which have no arm
  binaries), plus both CI jobs.
- **ffmpeg** (video + audio): already shipped for probe/thumbnails.
- **fflate** (npm): the OOXML/ODF rewrite; the zip patcher is dependency-free.

On a dev host, image/PDF/media uploads fail closed without these binaries —
see the README development section for the install line.

## Tests

- `src/lib/metadata-support.test.ts` — format→strategy map and warning
  summary.
- `src/server/metadata/strip.service.test.ts` — orchestration with fake
  strategies: routing, toggles, temp-rename atomicity, staging consumption,
  error propagation.
- `zip-patch.test.ts` / `office.test.ts` — pure-code strategies against
  hand-built fixtures (a byte-crafted zip with UT/uid-gid extras and
  comments; fflate-built docx/xlsx/odt with authors everywhere).
- `strategies.integration.test.ts` — the real binaries against generated
  dirty fixtures: asserts GPS/Artist are gone from a JPEG (orientation
  kept), tags gone from mp4/mp3 (streams intact), and that the author
  string appears nowhere in the PDF bytes after the qpdf pass. Skips per
  missing binary locally; CI installs all three so nothing skips there.
- e2e uploads a real generated mp4, exercising the strip path end to end.
