import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { FileView } from "@/lib/file-view";

/**
 * Icon link that forces a download of the canonical file URL. The `download`
 * attribute is honored because /f/* is same-origin with the app, and media is
 * served without a Content-Disposition header (PRD §4) that could override it.
 */
export function DownloadFileButton({ file }: { file: FileView }) {
  return (
    <Button variant="ghost" size="icon" asChild>
      <a
        href={file.canonicalUrl}
        download={file.fileName}
        aria-label={`Download ${file.fileName}`}
      >
        <Download />
      </a>
    </Button>
  );
}
