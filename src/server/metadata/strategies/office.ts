import { stat } from "node:fs/promises";
import { unzipSync, type Zippable, zipSync } from "fflate";
import { MetadataStripError } from "../errors";

/**
 * OOXML (docx/xlsx/pptx) and ODF (odt/ods/odp) are zip archives; exiftool can
 * read but not write them, so cleaning is zip surgery: replace the property
 * parts with empty templates and blank the author names that live in document
 * content parts (comments, tracked changes, spreadsheet absolute paths).
 *
 * Known limits (metadata only, never content): tracked-change and comment
 * *text* stays, as do docx rsid fingerprints — those are document content.
 * The archive is rebuilt with a fixed 1980 timestamp on every entry.
 */

/** The rewrite is in-memory; a "docx" beyond this is not a real document. */
const OFFICE_MAX_BYTES = 256 * 1024 * 1024;

/** Fixed DOS-epoch mtime for rebuilt entries (zip can't express earlier). */
const ZIP_EPOCH = new Date("1980-01-01T00:00:00Z");

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

const OOXML_CORE = `${XML_DECL}
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:creator></dc:creator><cp:lastModifiedBy></cp:lastModifiedBy></cp:coreProperties>`;

const OOXML_APP = `${XML_DECL}
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVT"></Properties>`;

// Emptied rather than deleted: [Content_Types].xml and the package rels still
// reference the part, and a dangling relationship breaks strict consumers.
const OOXML_CUSTOM = `${XML_DECL}
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVT"></Properties>`;

const ODF_META = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" xmlns:dc="http://purl.org/dc/elements/1.1/" office:version="1.2"><office:meta/></office:document-meta>`;

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** Blanks author-identity attributes/elements in an OOXML content part. */
function scrubOoxmlXml(path: string, xml: string): string {
  let out = xml
    // w:author / w15:author on comments, tracked changes, people.xml — plus
    // initials and the cloud userId that rides along in people.xml.
    .replace(/\b([\w]+:)?author="[^"]*"/g, '$1author=""')
    .replace(/\b([\w]+:)?initials="[^"]*"/g, '$1initials=""')
    .replace(/\b([\w]+:)?userId="[^"]*"/g, '$1userId=""')
    // xlsx workbooks record the absolute path of the saved file — which
    // contains the OS account name (C:\Users\Full Name\…).
    .replace(/(<x15ac:absPath[^>]*\burl=")[^"]*(")/g, "$1$2");
  // Legacy xlsx comments list authors as elements, not attributes.
  if (/xl\/comments[^/]*\.xml$/.test(path))
    out = out.replace(/<author>[^<]*<\/author>/g, "<author></author>");
  // pptx comment authors: name= is only safe to blank in this one part
  // (sheet/content name= attributes are semantic everywhere else).
  if (path === "ppt/commentAuthors.xml")
    out = out.replace(/\bname="[^"]*"/g, 'name=""');
  return out;
}

/** Blanks annotation creators (ODF comments carry <dc:creator>Name</>). */
function scrubOdfXml(xml: string): string {
  return xml.replace(
    /<dc:creator>[^<]*<\/dc:creator>/g,
    "<dc:creator></dc:creator>",
  );
}

export async function stripOffice(
  src: string,
  dest: string,
  ext: string,
): Promise<void> {
  const { size } = await stat(src);
  if (size > OFFICE_MAX_BYTES)
    throw new MetadataStripError(
      "Document is too large for metadata cleaning.",
    );

  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(new Uint8Array(await Bun.file(src).arrayBuffer()));
  } catch {
    throw new MetadataStripError(
      "File is not a valid Office document archive.",
    );
  }

  const isOdf = ext.startsWith("od");
  const out: Zippable = {};
  for (const [path, data] of Object.entries(entries)) {
    let content: Uint8Array = data;
    if (isOdf) {
      if (path === "meta.xml") content = encoder.encode(ODF_META);
      else if (path === "content.xml")
        content = encoder.encode(scrubOdfXml(decoder.decode(data)));
    } else {
      if (path === "docProps/core.xml") content = encoder.encode(OOXML_CORE);
      else if (path === "docProps/app.xml") content = encoder.encode(OOXML_APP);
      else if (path === "docProps/custom.xml")
        content = encoder.encode(OOXML_CUSTOM);
      else if (path.endsWith(".xml"))
        content = encoder.encode(scrubOoxmlXml(path, decoder.decode(data)));
    }
    // ODF requires `mimetype` first and stored (level 0); key order is
    // preserved from the source archive, which already had it first.
    out[path] =
      path === "mimetype" ? [content, { level: 0 }] : [content, { level: 6 }];
  }

  await Bun.write(dest, zipSync(out, { mtime: ZIP_EPOCH }));
}
