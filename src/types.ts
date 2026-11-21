export interface TaskDiffStats {
  filesChanged: number;
  sourceFilesCount: number;
  testFilesCount: number;
  testPatchBytes: number;
}

export interface MinedTask {
  id: string;
  repoPath: string;
  baseSha: string;
  fixSha: string;
  shortSha: string;
  commitDate: string;
  originalSubject: string;
  problemStatement: string;
  sourceFiles: string[];
  testFiles: string[];
  testPatch: string;
  diffStats: TaskDiffStats;
}

export interface LeakCheckResult {
  passed: boolean;
  commitCount: number;
  remotes: string[];
  tags: string[];
  fixShaPresent: boolean;
  reflogsPresent: boolean;
  violations: string[];
}

export interface ValidationResult {
  taskId: string;
  valid: boolean;
  baseFails: boolean;
  fixPasses: boolean;
  leakCheckPassed: boolean;
  baseExitCode: number;
  fixExitCode: number;
  baseDurationMs: number;
  fixDurationMs: number;
  reason?: string;
  baseOutput?: string;
  fixOutput?: string;
}

export interface VariantSpec {
  id: string;
  label: string;
  command: string;
  env?: Record<string, string>;
}

export interface TaskGradeResult {
  taskId: string;
  variantId: string;
  variantLabel: string;
  passed: boolean;
  failToPass: boolean;
  passToPass: boolean;
  leakCheckPassed: boolean;
  leakViolations: string[];
  agentExitCode: number;
  agentTimedOut: boolean;
  agentDurationMs: number;
  gradeDurationMs: number;
  changedFiles: string[];
  testPatchApplied: boolean;
  error?: string;
  gradeOutput?: string;
}

export interface VariantSummary {
  variantId: string;
  variantLabel: string;
  passedCount: number;
  totalCount: number;
  passRate: number;
  failToPassCount: number;
  passToPassCount: number;
  leakViolationsCount: number;
  avgAgentDurationMs: number;
  totalDurationMs: number;
}

export interface CompareReport {
  runId: string;
  createdAt: string;
  repoPath: string;
  testCommand: string;
  taskCount: number;
  validTaskCount: number;
  leakViolationsTotal: number;
  variants: [VariantSummary, VariantSummary];
  deltaPassRate: number;
  deltaPassedCount: number;
  winner: "A" | "B" | "tie";
  validations: ValidationResult[];
  results: TaskGradeResult[];
  tasks: MinedTask[];
  dbPath?: string;
}

export interface MineOptions {
  repoPath: string;
  days?: number;
  since?: string;
  limit?: number;
  maxScan?: number;
}

export interface ValidateOptions {
  testCommand: string;
  timeoutMs?: number;
  baseTempDir?: string;
}

export interface CompareOptions {
  repoPath: string;
  tasks: MinedTask[];
  variantA: VariantSpec;
  variantB: VariantSpec;
  testCommand: string;
  concurrency?: number;
  agentTimeoutMs?: number;
  testTimeoutMs?: number;
  validateFirst?: boolean;
  dbPath?: string;
  baseTempDir?: string;
}
