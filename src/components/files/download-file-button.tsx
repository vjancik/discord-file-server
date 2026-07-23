import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { FileView } from "@/lib/file-view";

/**
 * Icon link that forces a download of the canonical file URL. The `download`
 * attribute is honored because /f/* is same-origin with the app, and media is
 * served without a Content-Disposition header (PRD §4) that could override it.
 */
export function DownloadFileButton({ file }: { file: FileView }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" asChild>
          <a
            href={file.canonicalUrl}
            download={file.fileName}
            aria-label={`Download ${file.fileName}`}
          >
            <Download />
          </a>
        </Button>
      </TooltipTrigger>
      <TooltipContent>Download</TooltipContent>
    </Tooltip>
  );
}
