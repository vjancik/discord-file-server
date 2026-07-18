"use client";
// TanStack Table v8 is not React Compiler compatible (the table instance is
// mutated during render); compiler memoization wedges sorting in a render
// loop. Opt this module out and memoize inputs by hand.
"use no memo";

import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  type SortingState,
  useReactTable,
} from "@tanstack/react-table";
import { ArrowUpDown } from "lucide-react";
import { useMemo, useState } from "react";
import { CopyButton } from "@/components/copy-button";
import { DeleteFileButton } from "@/components/files/delete-file-button";
import {
  DateCell,
  StatusBadge,
  ThumbCell,
} from "@/components/files/file-cells";
import { PreviewDialog } from "@/components/files/preview-dialog";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { FileView } from "@/lib/file-view";
import { formatBytes } from "@/lib/units";

function sortableHeader(label: string) {
  return ({
    column,
  }: {
    column: {
      toggleSorting: (desc?: boolean) => void;
      getIsSorted: () => false | "asc" | "desc";
    };
  }) => (
    <Button
      variant="ghost"
      size="sm"
      className="-ml-3"
      onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
    >
      {label}
      <ArrowUpDown className="size-3.5" />
    </Button>
  );
}

export function FilesTable({
  files,
  skipConfirm,
}: {
  files: FileView[];
  skipConfirm: boolean;
}) {
  const [sorting, setSorting] = useState<SortingState>([
    { id: "createdAt", desc: true },
  ]);

  // Stable identity across renders — TanStack derives state from its inputs
  // and a fresh array every render can wedge it in a re-render loop.
  const columns: ColumnDef<FileView>[] = useMemo(
    () => [
      {
        id: "thumb",
        header: "",
        cell: ({ row }) => <ThumbCell file={row.original} />,
        enableSorting: false,
      },
      {
        accessorKey: "fileName",
        header: sortableHeader("Name"),
        cell: ({ row }) => (
          <span
            className="block max-w-72 truncate font-medium"
            title={row.original.fileName}
          >
            {row.original.fileName}
          </span>
        ),
      },
      {
        accessorKey: "sizeBytes",
        header: sortableHeader("Size"),
        cell: ({ row }) => formatBytes(row.original.sizeBytes),
      },
      {
        accessorKey: "createdAt",
        header: sortableHeader("Uploaded"),
        cell: ({ row }) => <DateCell iso={row.original.createdAt} />,
      },
      {
        accessorKey: "status",
        header: "Status",
        cell: ({ row }) => <StatusBadge status={row.original.status} />,
      },
      {
        id: "actions",
        header: "",
        enableSorting: false,
        cell: ({ row }) => (
          <div className="flex items-center justify-end gap-1">
            <CopyButton value={row.original.shortUrl} label="Link" />
            <PreviewDialog file={row.original} />
            <DeleteFileButton
              fileId={row.original.id}
              fileName={row.original.fileName}
              skipConfirm={skipConfirm}
            />
          </div>
        ),
      },
    ],
    [skipConfirm],
  );

  const table = useReactTable({
    data: files,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  if (files.length === 0) {
    return (
      <p className="rounded-md border border-dashed p-8 text-center text-muted-foreground">
        No files yet — go upload something.
      </p>
    );
  }

  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          {table.getHeaderGroups().map((hg) => (
            <TableRow key={hg.id}>
              {hg.headers.map((h) => (
                <TableHead key={h.id}>
                  {h.isPlaceholder
                    ? null
                    : flexRender(h.column.columnDef.header, h.getContext())}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows.map((row) => (
            <TableRow key={row.id}>
              {row.getVisibleCells().map((cell) => (
                <TableCell key={cell.id}>
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
