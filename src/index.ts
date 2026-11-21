export type {
  CompareOptions,
  CompareReport,
  LeakCheckResult,
  MineOptions,
  MinedTask,
  TaskDiffStats,
  TaskGradeResult,
  ValidateOptions,
  ValidationResult,
  VariantSpec,
  VariantSummary,
} from "./types.js";

export {
  isSourceFile,
  isTestFile,
  loadTasksFile,
  mineTasks,
  redactProblemStatement,
  saveTasksFile,
} from "./git/miner.js";

export {
  applyTestPatch,
  createLeakProofWorkspace,
  extractTarBuffer,
  getChangedFiles,
  resetTestFiles,
  runCommandWithTimeout,
  terminateProcessTree,
  verifyZeroGitLeak,
} from "./sandbox/leakproof.js";

export { compareVariants, validateTask } from "./runner/compare.js";
export { RunStore } from "./runner/store.js";
export {
  escapeHtml,
  formatHtmlReport,
  formatMarkdownReport,
  formatTerminalReport,
} from "./report/format.js";
export { createDemoFixture, runDemo } from "./demo/fixture.js";
export { runCli } from "./cli-app.js";
