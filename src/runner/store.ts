import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CompareReport, TaskGradeResult, ValidationResult } from "../types.js";

export interface StoredRunSummary {
  runId: string;
  createdAt: string;
  repoPath: string;
  testCommand: string;
  taskCount: number;
  validTaskCount: number;
  leakViolationsTotal: number;
  winner: string;
  deltaPassRate: number;
}

export class RunStore {
  private readonly db: DatabaseSync;
  public readonly dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    if (dbPath !== ":memory:") {
      fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec("PRAGMA foreign_keys = ON;");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        repo_path TEXT NOT NULL,
        test_command TEXT NOT NULL,
        task_count INTEGER NOT NULL,
        valid_task_count INTEGER NOT NULL,
        leak_violations_total INTEGER NOT NULL,
        winner TEXT NOT NULL,
        delta_pass_rate REAL NOT NULL,
        report_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS validations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        valid INTEGER NOT NULL,
        base_fails INTEGER NOT NULL,
        fix_passes INTEGER NOT NULL,
        leak_check_passed INTEGER NOT NULL,
        base_exit_code INTEGER NOT NULL,
        fix_exit_code INTEGER NOT NULL,
        base_duration_ms INTEGER NOT NULL,
        fix_duration_ms INTEGER NOT NULL,
        reason TEXT,
        FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS task_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        variant_id TEXT NOT NULL,
        variant_label TEXT NOT NULL,
        passed INTEGER NOT NULL,
        fail_to_pass INTEGER NOT NULL,
        pass_to_pass INTEGER NOT NULL,
        leak_check_passed INTEGER NOT NULL,
        leak_violations_json TEXT NOT NULL,
        agent_exit_code INTEGER NOT NULL,
        agent_timed_out INTEGER NOT NULL,
        agent_duration_ms INTEGER NOT NULL,
        grade_duration_ms INTEGER NOT NULL,
        changed_files_json TEXT NOT NULL,
        test_patch_applied INTEGER NOT NULL,
        error TEXT,
        FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
      );
    `);
  }

  public getJournalMode(): string {
    const row = this.db.prepare("PRAGMA journal_mode;").get() as
      | { journal_mode?: string }
      | undefined;
    return String(row?.journal_mode ?? "");
  }

  public saveReport(report: CompareReport): void {
    const insertRun = this.db.prepare(`
      INSERT OR REPLACE INTO runs (
        run_id, created_at, repo_path, test_command, task_count,
        valid_task_count, leak_violations_total, winner, delta_pass_rate, report_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertValidation = this.db.prepare(`
      INSERT INTO validations (
        run_id, task_id, valid, base_fails, fix_passes, leak_check_passed,
        base_exit_code, fix_exit_code, base_duration_ms, fix_duration_ms, reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertResult = this.db.prepare(`
      INSERT INTO task_results (
        run_id, task_id, variant_id, variant_label, passed, fail_to_pass,
        pass_to_pass, leak_check_passed, leak_violations_json, agent_exit_code,
        agent_timed_out, agent_duration_ms, grade_duration_ms, changed_files_json,
        test_patch_applied, error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.db.exec("BEGIN");
    try {
      insertRun.run(
        report.runId,
        report.createdAt,
        report.repoPath,
        report.testCommand,
        report.taskCount,
        report.validTaskCount,
        report.leakViolationsTotal,
        report.winner,
        report.deltaPassRate,
        JSON.stringify(report),
      );

      for (const v of report.validations) {
        insertValidation.run(
          report.runId,
          v.taskId,
          v.valid ? 1 : 0,
          v.baseFails ? 1 : 0,
          v.fixPasses ? 1 : 0,
          v.leakCheckPassed ? 1 : 0,
          v.baseExitCode,
          v.fixExitCode,
          v.baseDurationMs,
          v.fixDurationMs,
          v.reason ?? null,
        );
      }

      for (const r of report.results) {
        insertResult.run(
          report.runId,
          r.taskId,
          r.variantId,
          r.variantLabel,
          r.passed ? 1 : 0,
          r.failToPass ? 1 : 0,
          r.passToPass ? 1 : 0,
          r.leakCheckPassed ? 1 : 0,
          JSON.stringify(r.leakViolations),
          r.agentExitCode,
          r.agentTimedOut ? 1 : 0,
          r.agentDurationMs,
          r.gradeDurationMs,
          JSON.stringify(r.changedFiles),
          r.testPatchApplied ? 1 : 0,
          r.error ?? null,
        );
      }

      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  public listRuns(limit = 20): StoredRunSummary[] {
    const rows = this.db
      .prepare(`
        SELECT run_id, created_at, repo_path, test_command, task_count,
               valid_task_count, leak_violations_total, winner, delta_pass_rate
        FROM runs
        ORDER BY created_at DESC
        LIMIT ?
      `)
      .all(limit) as Array<{
      run_id: string;
      created_at: string;
      repo_path: string;
      test_command: string;
      task_count: number;
      valid_task_count: number;
      leak_violations_total: number;
      winner: string;
      delta_pass_rate: number;
    }>;

    return rows.map((row) => ({
      runId: row.run_id,
      createdAt: row.created_at,
      repoPath: row.repo_path,
      testCommand: row.test_command,
      taskCount: row.task_count,
      validTaskCount: row.valid_task_count,
      leakViolationsTotal: row.leak_violations_total,
      winner: row.winner,
      deltaPassRate: row.delta_pass_rate,
    }));
  }

  public getReport(runId: string): CompareReport | null {
    const row = this.db
      .prepare("SELECT report_json FROM runs WHERE run_id = ?")
      .get(runId) as { report_json?: string } | undefined;
    if (!row?.report_json) {
      return null;
    }
    return JSON.parse(row.report_json) as CompareReport;
  }

  public getTaskResults(runId: string): TaskGradeResult[] {
    const rows = this.db
      .prepare("SELECT * FROM task_results WHERE run_id = ? ORDER BY id ASC")
      .all(runId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      taskId: String(row.task_id),
      variantId: String(row.variant_id),
      variantLabel: String(row.variant_label),
      passed: Number(row.passed) === 1,
      failToPass: Number(row.fail_to_pass) === 1,
      passToPass: Number(row.pass_to_pass) === 1,
      leakCheckPassed: Number(row.leak_check_passed) === 1,
      leakViolations: JSON.parse(String(row.leak_violations_json)) as string[],
      agentExitCode: Number(row.agent_exit_code),
      agentTimedOut: Number(row.agent_timed_out) === 1,
      agentDurationMs: Number(row.agent_duration_ms),
      gradeDurationMs: Number(row.grade_duration_ms),
      changedFiles: JSON.parse(String(row.changed_files_json)) as string[],
      testPatchApplied: Number(row.test_patch_applied) === 1,
      error: row.error ? String(row.error) : undefined,
    }));
  }

  public getValidations(runId: string): ValidationResult[] {
    const rows = this.db
      .prepare("SELECT * FROM validations WHERE run_id = ? ORDER BY id ASC")
      .all(runId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      taskId: String(row.task_id),
      valid: Number(row.valid) === 1,
      baseFails: Number(row.base_fails) === 1,
      fixPasses: Number(row.fix_passes) === 1,
      leakCheckPassed: Number(row.leak_check_passed) === 1,
      baseExitCode: Number(row.base_exit_code),
      fixExitCode: Number(row.fix_exit_code),
      baseDurationMs: Number(row.base_duration_ms),
      fixDurationMs: Number(row.fix_duration_ms),
      reason: row.reason ? String(row.reason) : undefined,
    }));
  }

  public close(): void {
    this.db.close();
  }
}
