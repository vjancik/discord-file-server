"use client";
// TanStack Table v8 is not React Compiler compatible (the table instance is
// mutated during render); compiler memoization wedges sorting in a render
// loop. Opt this module out and memoize inputs by hand.
"use no memo";

import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  type SortingState,
  useReactTable,
} from "@tanstack/react-table";
import { ArrowUpDown } from "lucide-react";
import { useMemo, useState } from "react";
import { DeleteFileButton } from "@/components/files/delete-file-button";
import {
  DateCell,
  StatusBadge,
  ThumbCell,
} from "@/components/files/file-cells";
import { PreviewDialog } from "@/components/files/preview-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { cn } from "@/lib/utils";

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

/** Global file browser (PRD §6): all files incl. tombstones, filter + sort, preview + delete. */
export function AdminFilesTable({
  files,
  skipConfirm,
}: {
  files: FileView[];
  skipConfirm: boolean;
}) {
  const [sorting, setSorting] = useState<SortingState>([
    { id: "createdAt", desc: true },
  ]);
  const [search, setSearch] = useState("");
  const [kindFilter, setKindFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");

  // Table inputs need stable identities across renders — a fresh data array
  // every render makes TanStack re-derive state and loop.
  const filtered = useMemo(
    () =>
      files.filter((f) => {
        if (kindFilter !== "all" && f.kind !== kindFilter) return false;
        if (statusFilter === "deleted" && !f.deletedAt) return false;
        if (
          statusFilter === "pending" &&
          (f.status !== "pending" || f.deletedAt)
        )
          return false;
        if (
          statusFilter === "approved" &&
          (f.status !== "approved" || f.deletedAt)
        )
          return false;
        const q = search.trim().toLowerCase();
        if (
          q &&
          !f.fileName.toLowerCase().includes(q) &&
          !(f.ownerName ?? "").toLowerCase().includes(q)
        )
          return false;
        return true;
      }),
    [files, kindFilter, statusFilter, search],
  );

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
            className={cn(
              "block max-w-64 truncate font-medium",
              row.original.deletedAt && "text-muted-foreground line-through",
            )}
            title={row.original.fileName}
          >
            {row.original.fileName}
          </span>
        ),
      },
      {
        accessorKey: "ownerName",
        header: sortableHeader("User"),
        cell: ({ row }) => row.original.ownerName ?? "—",
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
        id: "status",
        header: "Status",
        cell: ({ row }) =>
          row.original.deletedAt ? (
            <Badge variant="destructive">deleted</Badge>
          ) : (
            <StatusBadge status={row.original.status} />
          ),
      },
      {
        id: "actions",
        header: "",
        enableSorting: false,
        cell: ({ row }) =>
          row.original.deletedAt ? null : (
            <div className="flex items-center justify-end gap-1">
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
    data: filtered,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          placeholder="Search name or user…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-60"
        />
        <Select value={kindFilter} onValueChange={setKindFilter}>
          <SelectTrigger className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            <SelectItem value="video">Video</SelectItem>
            <SelectItem value="image">Image</SelectItem>
            <SelectItem value="audio">Audio</SelectItem>
            <SelectItem value="other">Other</SelectItem>
          </SelectContent>
        </Select>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="pending">Pending</SelectItem>
            <SelectItem value="approved">Approved</SelectItem>
            <SelectItem value="deleted">Deleted</SelectItem>
          </SelectContent>
        </Select>
        <span className="ml-auto text-muted-foreground text-sm">
          {filtered.length} of {files.length} files
        </span>
      </div>

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
              <TableRow
                key={row.id}
                className={cn(row.original.deletedAt && "opacity-60")}
              >
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
    </div>
  );
}
