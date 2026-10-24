"use client";

import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getPaginationRowModel,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import {
  DataGrid,
  DataGridContainer,
} from "@/components/reui/data-grid/data-grid";
import { DataGridTable } from "@/components/reui/data-grid/data-grid-table";
import { DataGridPagination } from "@/components/reui/data-grid/data-grid-pagination";
import { DataGridColumnHeader } from "@/components/reui/data-grid/data-grid-column-header";
import { ModelBadge } from "@/components/shared/model-badge";
import { StatusBadge } from "@/components/shared/status-badge";
import { RunningBadge, useRunningStoryIds } from "@/components/agents/running-story";
import type { StoryDetail } from "@/lib/bmad/types";
import { storyNumber } from "@/lib/bmad/story-number";

/** Story numbers ("1.3") as small chips; a number that is in this list links to its story. */
function NumberChips({
  numbers,
  hrefFor,
  muted,
}: {
  numbers: string[];
  hrefFor: (number: string) => string | null;
  muted: boolean;
}) {
  if (numbers.length === 0) return <span className="text-muted-foreground">-</span>;
  const chipClass = `rounded-md border px-1.5 py-0.5 text-xs ${
    muted ? "border-border text-muted-foreground" : "border-primary/40 text-primary"
  }`;
  return (
    <span className="flex flex-wrap gap-1">
      {numbers.map((number) => {
        const href = hrefFor(number);
        return href ? (
          <Link key={number} href={href} onClick={(e) => e.stopPropagation()} className={chipClass}>
            {number}
          </Link>
        ) : (
          <span key={number} className={chipClass}>
            {number}
          </span>
        );
      })}
    </span>
  );
}

function TaskGauge({ completed, total }: { completed: number; total: number }) {
  const size = 44;
  const stroke = 5;
  const radius = (size - stroke) / 2;
  const circumference = Math.PI * radius;
  const percent = total > 0 ? completed / total : 0;
  const filledLength = circumference * percent;
  const remainingLength = circumference - filledLength;
  const svgH = size / 2 + stroke / 2;

  return (
    <div className="inline-flex flex-col items-center gap-0.5">
      <svg
        width={size}
        height={svgH}
        viewBox={`0 0 ${size} ${svgH}`}
      >
        <path
          d={`M ${stroke / 2} ${svgH - 1} A ${radius} ${radius} 0 0 1 ${size - stroke / 2} ${svgH - 1}`}
          fill="none"
          stroke="currentColor"
          strokeWidth={stroke}
          strokeLinecap="round"
          className="text-muted-foreground/20"
        />
        {percent > 0 && (
          <path
            d={`M ${stroke / 2} ${svgH - 1} A ${radius} ${radius} 0 0 1 ${size - stroke / 2} ${svgH - 1}`}
            fill="none"
            stroke="currentColor"
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${filledLength} ${remainingLength}`}
            className={percent >= 1 ? "text-success" : "text-success/70"}
          />
        )}
      </svg>
      <span className="text-xs font-semibold tabular-nums text-muted-foreground">
        {completed}/{total}
      </span>
    </div>
  );
}

function storyHref(basePath: string, storyId: string) {
  return `${basePath}/${encodeURIComponent(storyId)}`;
}

function getColumns(
  basePath: string,
  running: Set<string>,
  idByNumber: Map<string, string>,
): ColumnDef<StoryDetail>[] {
  const hrefFor = (number: string) => {
    const id = idByNumber.get(number);
    return id ? storyHref(basePath, id) : null;
  };
  return [
    {
      accessorKey: "id",
      header: "ID",
      cell: ({ row }) => (
        <span className="font-mono text-xs text-muted-foreground">
          S{row.getValue("id")}
        </span>
      ),
      size: 80,
      enableSorting: false,
    },
    {
      accessorKey: "title",
      header: ({ column }) => (
        <DataGridColumnHeader column={column} title="Title" />
      ),
      cell: ({ row }) => (
        <Link
          href={storyHref(basePath, row.original.id)}
          onClick={(e) => e.stopPropagation()}
          className="font-medium hover:underline"
        >
          {row.getValue("title")}
        </Link>
      ),
    },
    {
      accessorKey: "status",
      header: ({ column }) => (
        <DataGridColumnHeader column={column} title="Status" />
      ),
      cell: ({ row }) => (
        <div className="flex items-center gap-2">
          <StatusBadge status={row.getValue("status")} />
          {running.has(row.original.id) && <RunningBadge />}
        </div>
      ),
    },
    {
      id: "dependsOn",
      header: "Depends on",
      cell: ({ row }) => (
        <NumberChips numbers={row.original.dependsOn ?? []} hrefFor={hrefFor} muted={false} />
      ),
      enableSorting: false,
    },
    {
      id: "parallelWith",
      header: "Can run now",
      cell: ({ row }) => (
        <NumberChips numbers={row.original.parallelWith ?? []} hrefFor={hrefFor} muted />
      ),
      enableSorting: false,
    },
    {
      accessorKey: "epicTitle",
      header: ({ column }) => (
        <DataGridColumnHeader column={column} title="Epic" />
      ),
      cell: ({ row }) => (
        <span className="text-sm text-muted-foreground">
          {row.getValue("epicTitle") || "-"}
        </span>
      ),
    },
    {
      id: "model",
      header: "Model",
      cell: ({ row }) => {
        const advice = row.original.modelAdvice;
        if (!advice) return <span className="text-muted-foreground">-</span>;
        return <ModelBadge advice={advice} compact />;
      },
      enableSorting: false,
    },
    {
      accessorKey: "totalTasks",
      header: "Tasks",
      cell: ({ row }) => {
        const story = row.original;
        if (story.totalTasks === 0) return <span className="text-muted-foreground">-</span>;
        return <TaskGauge completed={story.completedTasks} total={story.totalTasks} />;
      },
      size: 80,
      enableSorting: false,
    },
  ];
}

interface StoriesTableProps {
  stories: StoryDetail[];
}

export function StoriesTable({ stories }: StoriesTableProps) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const router = useRouter();
  const pathname = usePathname();
  const running = useRunningStoryIds();
  const idByNumber = useMemo(() => {
    const map = new Map<string, string>();
    for (const story of stories) {
      const number = storyNumber(story.id);
      if (number) map.set(number, story.id);
    }
    return map;
  }, [stories]);
  const columns = useMemo(
    () => getColumns(pathname, running, idByNumber),
    [pathname, running, idByNumber],
  );

  const table = useReactTable({
    data: stories,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    onSortingChange: setSorting,
    state: { sorting },
    initialState: { pagination: { pageSize: 20 } },
  });

  const handleRowClick = (story: StoryDetail) => {
    router.push(storyHref(pathname, story.id));
  };

  return (
    <DataGrid
      table={table}
      recordCount={stories.length}
      tableLayout={{
        headerSticky: true,
        headerBackground: true,
        headerBorder: true,
        rowBorder: true,
      }}
      onRowClick={handleRowClick}
    >
      <DataGridContainer>
        <DataGridTable />
      </DataGridContainer>
      {table.getPageCount() > 1 && (
        <DataGridPagination
          sizes={[10, 20, 50]}
          info="{from} - {to} of {count}"
        />
      )}
    </DataGrid>
  );
}
