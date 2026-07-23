import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { strFromU8, unzipSync, zipSync } from "fflate";
import { MetadataStripError } from "../errors";
import { stripOffice } from "./office";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "office-test-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const enc = (s: string) => new TextEncoder().encode(s);

async function writeZip(
  name: string,
  entries: Record<string, Uint8Array>,
): Promise<string> {
  const p = path.join(tmp, name);
  await Bun.write(p, zipSync(entries, { mtime: new Date("2024-06-01") }));
  return p;
}

const DOCX_CORE = `<?xml version="1.0"?><cp:coreProperties xmlns:cp="x" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>John Doe</dc:creator><cp:lastModifiedBy>John Doe</cp:lastModifiedBy></cp:coreProperties>`;
const DOCX_APP = `<?xml version="1.0"?><Properties xmlns="x"><Company>ACME Corp</Company><TotalTime>123</TotalTime></Properties>`;
const DOCX_CUSTOM = `<?xml version="1.0"?><Properties xmlns="x"><property name="Owner">John Doe</property></Properties>`;
const DOCX_DOCUMENT = `<?xml version="1.0"?><w:document xmlns:w="x"><w:body><w:ins w:id="1" w:author="John Doe" w:date="2024-06-01"><w:r><w:t>Hello world</w:t></w:r></w:ins></w:body></w:document>`;
const DOCX_PEOPLE = `<?xml version="1.0"?><w15:people xmlns:w15="x"><w15:person w15:author="John Doe"><w15:presenceInfo w15:providerId="AD" w15:userId="john.doe@acme.example"/></w15:person></w15:people>`;

describe("stripOffice: OOXML", () => {
  test("replaces property parts and blanks author identities, keeping content", async () => {
    const src = await writeZip("in.docx", {
      "[Content_Types].xml": enc("<Types/>"),
      "docProps/core.xml": enc(DOCX_CORE),
      "docProps/app.xml": enc(DOCX_APP),
      "docProps/custom.xml": enc(DOCX_CUSTOM),
      "word/document.xml": enc(DOCX_DOCUMENT),
      "word/people.xml": enc(DOCX_PEOPLE),
      "word/media/image1.png": new Uint8Array([1, 2, 3, 4]),
    });
    const dest = path.join(tmp, "out.docx");

    await stripOffice(src, dest, "docx");

    const out = unzipSync(new Uint8Array(await Bun.file(dest).arrayBuffer()));
    const text = (p: string) => strFromU8(out[p]);

    expect(text("docProps/core.xml")).not.toContain("John");
    expect(text("docProps/app.xml")).not.toContain("ACME");
    expect(text("docProps/custom.xml")).not.toContain("John");
    // tracked-change author blanked, content intact
    expect(text("word/document.xml")).toContain('w:author=""');
    expect(text("word/document.xml")).toContain("Hello world");
    // people part: author name and cloud userId blanked
    expect(text("word/people.xml")).not.toContain("John");
    expect(text("word/people.xml")).not.toContain("acme.example");
    // binary parts untouched
    expect(out["word/media/image1.png"]).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  test("xlsx: comment authors and the absolute save path are blanked", async () => {
    const src = await writeZip("in.xlsx", {
      "xl/workbook.xml": enc(
        `<workbook><mc:AlternateContent xmlns:mc="m"><x15ac:absPath xmlns:x15ac="a" url="C:\\Users\\John Doe\\Documents\\"/></mc:AlternateContent></workbook>`,
      ),
      "xl/comments1.xml": enc(
        `<comments><authors><author>John Doe</author></authors></comments>`,
      ),
    });
    const dest = path.join(tmp, "out.xlsx");

    await stripOffice(src, dest, "xlsx");

    const out = unzipSync(new Uint8Array(await Bun.file(dest).arrayBuffer()));
    expect(strFromU8(out["xl/workbook.xml"])).not.toContain("John");
    expect(strFromU8(out["xl/comments1.xml"])).not.toContain("John");
  });
});

describe("stripOffice: ODF", () => {
  test("replaces meta.xml, blanks annotation creators, keeps mimetype first and stored", async () => {
    const src = await writeZip("in.odt", {
      // mimetype must be first and stored — build it that way going in
      mimetype: enc("application/vnd.oasis.opendocument.text"),
      "meta.xml": enc(
        `<office:document-meta xmlns:office="o"><office:meta><meta:initial-creator xmlns:meta="m">John Doe</meta:initial-creator></office:meta></office:document-meta>`,
      ),
      "content.xml": enc(
        `<office:document-content xmlns:office="o" xmlns:dc="d"><office:annotation><dc:creator>John Doe</dc:creator><text>note</text></office:annotation><text:p xmlns:text="t">Body text</text:p></office:document-content>`,
      ),
    });
    const dest = path.join(tmp, "out.odt");

    await stripOffice(src, dest, "odt");

    const bytes = Buffer.from(await Bun.file(dest).arrayBuffer());
    const out = unzipSync(new Uint8Array(bytes));
    expect(strFromU8(out["meta.xml"])).not.toContain("John");
    expect(strFromU8(out["content.xml"])).not.toContain("John");
    expect(strFromU8(out["content.xml"])).toContain("Body text");
    expect(strFromU8(out.mimetype)).toBe(
      "application/vnd.oasis.opendocument.text",
    );

    // first local entry is `mimetype`, stored (method 0) per ODF spec
    expect(bytes.readUInt32LE(0)).toBe(0x04034b50);
    expect(bytes.readUInt16LE(8)).toBe(0); // compression method
    const nameLen = bytes.readUInt16LE(26);
    expect(bytes.subarray(30, 30 + nameLen).toString()).toBe("mimetype");
  });
});

describe("stripOffice: guards", () => {
  test("rejects a non-zip file", async () => {
    const src = path.join(tmp, "fake.docx");
    await Bun.write(src, "not a zip at all");
    await expect(
      stripOffice(src, path.join(tmp, "out.docx"), "docx"),
    ).rejects.toBeInstanceOf(MetadataStripError);
  });
});
