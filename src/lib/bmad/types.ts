export type StoryStatus =
  | "done"
  | "in-progress"
  | "review"
  | "blocked"
  | "ready-for-dev"
  | "backlog"
  | "unknown";

export type EpicStatus = "done" | "in-progress" | "not-started";

export interface SprintStatus {
  sprint?: string;
  status?: string;
  startDate?: string;
  endDate?: string;
  stories: SprintStoryEntry[];
}

export interface SprintStoryEntry {
  id: string;
  title: string;
  status: StoryStatus;
  epicId?: string;
}

export interface Epic {
  id: string;
  title: string;
  description: string;
  status: EpicStatus;
  stories: string[];
  /** Story titles keyed by story id, from "### Story N.M: Title" headings. */
  storyTitles?: Record<string, string>;
  totalStories: number;
  completedStories: number;
  progressPercent: number;
}

export interface StoryDetail {
  id: string;
  title: string;
  status: StoryStatus;
  /**
   * True when the story markdown declared a status explicitly (frontmatter
   * `status:` or a `Status:` line in the body). When false, `status` came
   * from the default fallback and sprint-status.yaml may override it.
   */
  statusExplicit?: boolean;
  /**
   * Part label when the file holds one part of a story split over several
   * files ("1-2-part-1-…" → "1", "1-2-parts-2-5-…" → "2-5"). Parts are merged
   * into a single story before correlation.
   */
  part?: string;
  /** Number of files merged into this story (only set when more than one). */
  partCount?: number;
  /** Recommended model from a story-complexity table, when the project has one. */
  modelAdvice?: StoryModelAdvice;
  /** Project-relative paths of the story's own file(s); absent for sprint-status stubs. */
  sourcePaths?: string[];
  epicId: string;
  epicTitle?: string;
  description: string;
  acceptanceCriteria: string[];
  tasks: StoryTask[];
  completedTasks: number;
  totalTasks: number;
}

export type ModelTier = "haiku" | "sonnet" | "opus";

export interface ModelAdviceRow {
  /** Story id as written in the table ("1.2", "1.2a"). */
  id: string;
  title?: string;
  /** Complexity as written ("S", "M", "L", "XL"). */
  complexity?: string;
  /** Model cell as written, e.g. "Opus (core) · Haiku (theme)". */
  model: string;
  /** Model tiers named in the model cell, in order. */
  tiers: ModelTier[];
  reason?: string;
  /** Optional "Plan model" column: who writes the spec, when it differs from the build model. */
  planModel?: string;
  planTiers?: ModelTier[];
  /** Optional "Review model" column: who reviews the built story. */
  reviewModel?: string;
  reviewTiers?: ModelTier[];
}

export interface StoryModelAdvice extends ModelAdviceRow {
  /** Rows for parts of this story ("1.2a", "1.2b") that are not stories themselves. */
  parts?: ModelAdviceRow[];
}

export interface StoryTask {
  description: string;
  completed: boolean;
}

export interface FileTreeNode {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: FileTreeNode[];
}

export type BmadFileMetadata = {
  status?: string;
  stepsCompleted?: string[];
  lastStep?: string | number;
  title?: string;
  completedAt?: string;
  workflowType?: string;
};

export type ParsedBmadFile = {
  contentType: "markdown" | "yaml" | "json" | "text";
  frontmatter: Record<string, unknown> | null;
  metadata: BmadFileMetadata | null;
  body: string;
  rawContent: string;
  parseError: string | null;
};

export interface ParseErrorEntry {
  file: string;
  error: string;
  contentType: string;
}

export interface ParseHealthReport {
  errors: ParseErrorEntry[];
  totalFiles: number;
  successfulFiles: number;
}

export interface BmadProject {
  owner: string;
  repo: string;
  branch: string;
  displayName: string;
  sprintStatus: SprintStatus | null;
  epics: Epic[];
  stories: StoryDetail[];
  fileTree: FileTreeNode[];
  bmadFiles: string[];
  docsTree: FileTreeNode[];
  docsFolderName: string | null;
  parseHealth?: ParseHealthReport;
  totalStories: number;
  completedStories: number;
  inProgressStories: number;
  progressPercent: number;
}
