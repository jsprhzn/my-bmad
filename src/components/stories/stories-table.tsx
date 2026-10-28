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

const CHIP = "rounded-md border border-border px-1.5 py-0.5 text-xs text-muted-foreground";

/** Story numbers ("1.3") as quiet chips; a number that is in this list links to its story. */
function NumberChips({
  numbers,
  hrefFor,
  statusOf,
  max,
}: {
  numbers: string[];
  hrefFor: (number: string) => string | null;
  /** A done story gets a green border, like the Done badge. */
  statusOf?: (number: string) => string | null;
  /** Show this many chips and count the rest as "+N". */
  max?: number;
}) {
  if (numbers.length === 0) return <span className="text-muted-foreground">-</span>;
  const shown = max ? numbers.slice(0, max) : numbers;
  const rest = numbers.length - shown.length;
  return (
    <span className="flex flex-wrap gap-1">
      {shown.map((number) => {
        const href = hrefFor(number);
        const className = statusOf?.(number) === "done" ? `${CHIP} border-success/50` : CHIP;
        return href ? (
          <Link key={number} href={href} onClick={(e) => e.stopPropagation()} className={className}>
            {number}
          </Link>
        ) : (
          <span key={number} className={className}>
            {number}
          </span>
        );
      })}
      {rest > 0 && <span className={CHIP}>+{rest}</span>}
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
  running: Map<string, string>,
  storyByNumber: Map<string, StoryDetail>,
): ColumnDef<StoryDetail>[] {
  const hrefFor = (number: string) => {
    const story = storyByNumber.get(number);
    return story ? storyHref(basePath, story.id) : null;
  };
  const statusOf = (number: string) => storyByNumber.get(number)?.status ?? null;
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
          {running.has(row.original.id) && <RunningBadge href={running.get(row.original.id)} />}
        </div>
      ),
    },
    {
      id: "dependsOn",
      header: "Depends on",
      cell: ({ row }) => (
        <NumberChips
          numbers={row.original.dependsOn ?? []}
          hrefFor={hrefFor}
          statusOf={statusOf}
        />
      ),
      enableSorting: false,
    },
    {
      id: "parallelWith",
      header: "Can run now",
      cell: ({ row }) => (
        <NumberChips numbers={row.original.parallelWith ?? []} hrefFor={hrefFor} max={3} />
      ),
      enableSorting: false,
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
  /** All stories, for looking up dependencies that a filter has hidden. Defaults to `stories`. */
  lookup?: StoryDetail[];
}

/** One section per epic, so the epic is not repeated on every row. */
export function StoriesTable({ stories, lookup = stories }: StoriesTableProps) {
  const groups = useMemo(() => {
    const byEpic = new Map<string, { title: string; stories: StoryDetail[] }>();
    for (const story of stories) {
      const group = byEpic.get(story.epicId) ?? {
        title: story.epicTitle ?? `Epic ${story.epicId}`,
        stories: [],
      };
      group.stories.push(story);
      byEpic.set(story.epicId, group);
    }
    return [...byEpic.entries()];
  }, [stories]);
  // Across all epics: a dependency can sit in another epic than the story that needs it.
  const storyByNumber = useMemo(() => {
    const map = new Map<string, StoryDetail>();
    for (const story of lookup) {
      const number = storyNumber(story.id);
      if (number) map.set(number, story);
    }
    return map;
  }, [lookup]);

  return (
    <div className="space-y-8">
      {groups.map(([epicId, group]) => (
        <section key={epicId} className="space-y-3">
          <div className="flex items-baseline gap-2">
            <h2 className="text-lg font-medium">{group.title}</h2>
            <span className="text-sm text-muted-foreground">{group.stories.length} stories</span>
          </div>
          <StoriesGrid stories={group.stories} storyByNumber={storyByNumber} />
        </section>
      ))}
    </div>
  );
}

function StoriesGrid({
  stories,
  storyByNumber,
}: StoriesTableProps & { storyByNumber: Map<string, StoryDetail> }) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const router = useRouter();
  const pathname = usePathname();
  const running = useRunningStoryIds();
  const columns = useMemo(
    () => getColumns(pathname, running, storyByNumber),
    [pathname, running, storyByNumber],
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
