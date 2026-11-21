import type { CompareReport, TaskGradeResult } from "../types.js";

function padRight(value: string, width: number): string {
  if (value.length >= width) {
    return value.slice(0, width);
  }
  return value + " ".repeat(width - value.length);
}

function padLeft(value: string, width: number): string {
  if (value.length >= width) {
    return value.slice(0, width);
  }
  return " ".repeat(width - value.length) + value;
}

function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatDelta(delta: number, suffix = "", decimals?: number): string {
  const sign = delta > 0 ? "+" : "";
  const formatted = decimals !== undefined ? delta.toFixed(decimals) : String(delta);
  return `${sign}${formatted}${suffix}`;
}

function escapeMarkdownCell(input: string): string {
  return input
    .replace(/[\r\n]+/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .trim();
}

function formatMarkdownCode(input: string): string {
  const clean = input.replace(/[\r\n]+/g, " ");
  const fence = clean.includes("`") ? "``" : "`";
  const padded = clean.startsWith("`") || clean.endsWith("`") ? ` ${clean} ` : clean;
  return `${fence}${padded}${fence}`;
}

function findResult(
  results: TaskGradeResult[],
  taskId: string,
  variantId: string,
): TaskGradeResult | undefined {
  return results.find((r) => r.taskId === taskId && r.variantId === variantId);
}

function formatCellStatus(result: TaskGradeResult | undefined): string {
  if (!result) {
    return "SKIP";
  }
  if (result.passed) {
    return "PASS";
  }
  if (result.agentTimedOut) {
    return "TIMEOUT";
  }
  if (!result.passToPass) {
    return "REGRESS";
  }
  return "FAIL";
}

export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function formatTerminalReport(report: CompareReport): string {
  const [varA, varB] = report.variants;
  const lines: string[] = [];

  const divider = "=".repeat(78);
  const subDivider = "-".repeat(78);

  lines.push(divider);
  lines.push("  commitbench A/B Scorecard");
  lines.push(divider);
  lines.push(`  Run ID:          ${report.runId}`);
  lines.push(`  Tasks:           ${report.validTaskCount}/${report.taskCount} validated`);
  lines.push(`  Test Command:    ${report.testCommand}`);
  lines.push(`  Leak Check:      ${report.leakViolationsTotal} git-leak violations`);
  lines.push(subDivider);

  const header = [
    padRight("Variant", 30),
    padLeft("Passed", 10),
    padLeft("Pass Rate", 11),
    padLeft("F2P", 7),
    padLeft("P2P", 7),
    padLeft("Avg Time", 11),
  ].join(" ");
  lines.push(header);
  lines.push(subDivider);

  for (const summary of [varA, varB]) {
    const label = `[${summary.variantId}] ${summary.variantLabel}`;
    const row = [
      padRight(label, 30),
      padLeft(`${summary.passedCount}/${summary.totalCount}`, 10),
      padLeft(`${summary.passRate.toFixed(1)}%`, 11),
      padLeft(`${summary.failToPassCount}/${summary.totalCount}`, 7),
      padLeft(`${summary.passToPassCount}/${summary.totalCount}`, 7),
      padLeft(formatDuration(summary.avgAgentDurationMs), 11),
    ].join(" ");
    lines.push(row);
  }

  lines.push(subDivider);
  const winnerLabel =
    report.winner === "B"
      ? `Variant B (${varB.variantLabel})`
      : report.winner === "A"
        ? `Variant A (${varA.variantLabel})`
        : "Tie";

  lines.push(
    `  Delta (B vs A):  ${formatDelta(report.deltaPassedCount)} tasks (${formatDelta(report.deltaPassRate, "%", 1)}) | Winner: ${winnerLabel}`,
  );
  lines.push(divider);
  lines.push("  Per-Task Breakdown:");
  lines.push(
    `  ${padRight("Task ID", 16)} ${padRight("Variant A", 10)} ${padRight("Variant B", 10)} ${padRight("Subject", 38)}`,
  );
  lines.push(`  ${"-".repeat(74)}`);

  for (const task of report.tasks) {
    const resA = findResult(report.results, task.id, varA.variantId);
    const resB = findResult(report.results, task.id, varB.variantId);
    lines.push(
      `  ${padRight(task.id, 16)} ${padRight(formatCellStatus(resA), 10)} ${padRight(formatCellStatus(resB), 10)} ${padRight(task.originalSubject, 38)}`,
    );
  }

  lines.push(divider);
  return lines.join("\n");
}

export function formatMarkdownReport(report: CompareReport): string {
  const [varA, varB] = report.variants;
  const winnerText =
    report.winner === "B"
      ? `Variant B (${escapeMarkdownCell(varB.variantLabel)})`
      : report.winner === "A"
        ? `Variant A (${escapeMarkdownCell(varA.variantLabel)})`
        : "Tie";

  const lines: string[] = [
    "## commitbench A/B Benchmark Report",
    "",
    `- **Run ID**: ${formatMarkdownCode(report.runId)}`,
    `- **Validated Tasks**: ${report.validTaskCount}/${report.taskCount}`,
    `- **Test Command**: ${formatMarkdownCode(report.testCommand)}`,
    `- **Git-Leak Audit**: ${report.leakViolationsTotal} git-leak violations`,
    `- **Delta (B vs A)**: ${formatDelta(report.deltaPassedCount)} tasks (${formatDelta(report.deltaPassRate, "%", 1)}) | **Winner**: ${winnerText}`,
    "",
    "### Variant Scorecard",
    "",
    "| Variant | Label | Passed | Pass Rate | Fail-to-Pass | Pass-to-Pass | Avg Agent Time | Leak Violations |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    `| ${escapeMarkdownCell(varA.variantId)} | ${escapeMarkdownCell(varA.variantLabel)} | ${varA.passedCount}/${varA.totalCount} | ${varA.passRate.toFixed(1)}% | ${varA.failToPassCount}/${varA.totalCount} | ${varA.passToPassCount}/${varA.totalCount} | ${formatDuration(varA.avgAgentDurationMs)} | ${varA.leakViolationsCount} |`,
    `| ${escapeMarkdownCell(varB.variantId)} | ${escapeMarkdownCell(varB.variantLabel)} | ${varB.passedCount}/${varB.totalCount} | ${varB.passRate.toFixed(1)}% | ${varB.failToPassCount}/${varB.totalCount} | ${varB.passToPassCount}/${varB.totalCount} | ${formatDuration(varB.avgAgentDurationMs)} | ${varB.leakViolationsCount} |`,
    "",
    "### Per-Task Results",
    "",
    "| Task ID | Commit | Variant A | Variant B | Subject |",
    "| --- | --- | --- | --- | --- |",
  ];

  for (const task of report.tasks) {
    const resA = findResult(report.results, task.id, varA.variantId);
    const resB = findResult(report.results, task.id, varB.variantId);
    const safeSubject = escapeMarkdownCell(task.originalSubject);
    lines.push(
      `| ${formatMarkdownCode(task.id)} | ${formatMarkdownCode(task.shortSha)} | ${formatCellStatus(resA)} | ${formatCellStatus(resB)} | ${safeSubject} |`,
    );
  }

  return lines.join("\n");
}

export function formatHtmlReport(report: CompareReport): string {
  const [varA, varB] = report.variants;
  const winnerText =
    report.winner === "B"
      ? `Variant B (${varB.variantLabel})`
      : report.winner === "A"
        ? `Variant A (${varA.variantLabel})`
        : "Tie";

  const taskRows = report.tasks
    .map((task) => {
      const resA = findResult(report.results, task.id, varA.variantId);
      const resB = findResult(report.results, task.id, varB.variantId);
      const statusA = formatCellStatus(resA);
      const statusB = formatCellStatus(resB);
      const badgeClassFor = (status: string) =>
        status === "PASS" ? "badge-pass" : status === "SKIP" ? "badge-skip" : "badge-fail";
      const badgeClassA = badgeClassFor(statusA);
      const badgeClassB = badgeClassFor(statusB);
      const errNote = [
        resA?.error ? `A: ${resA.error}` : "",
        resB?.error ? `B: ${resB.error}` : "",
      ]
        .filter(Boolean)
        .join(" | ");

      return `
        <tr>
          <td><code>${escapeHtml(task.id)}</code></td>
          <td><code>${escapeHtml(task.shortSha)}</code></td>
          <td><span class="badge ${badgeClassA}">${escapeHtml(statusA)}</span></td>
          <td><span class="badge ${badgeClassB}">${escapeHtml(statusB)}</span></td>
          <td>${escapeHtml(task.originalSubject)}</td>
          <td class="muted">${escapeHtml(errNote || "Clean")}</td>
        </tr>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>commitbench Report: ${escapeHtml(report.runId)}</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #0f172a;
      --card: #1e293b;
      --border: #334155;
      --text: #f8fafc;
      --muted: #94a3b8;
      --pass-bg: #14532d;
      --pass-fg: #86efac;
      --fail-bg: #7f1d1d;
      --fail-fg: #fca5a5;
      --accent: #38bdf8;
    }
    @media (prefers-color-scheme: light) {
      :root {
        --bg: #f8fafc;
        --card: #ffffff;
        --border: #e2e8f0;
        --text: #0f172a;
        --muted: #475569;
        --pass-bg: #dcfce7;
        --pass-fg: #166534;
        --fail-bg: #fee2e2;
        --fail-fg: #991b1b;
        --accent: #0284c7;
      }
    }
    body {
      font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      margin: 0;
      padding: 2rem;
      line-height: 1.5;
    }
    .container { max-width: 1080px; margin: 0 auto; }
    h1, h2 { margin-top: 0; }
    .meta { color: var(--muted); font-size: 0.92rem; margin-bottom: 1.5rem; }
    .cards {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 1rem;
      margin-bottom: 1.75rem;
    }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 1rem 1.25rem;
    }
    .card-label { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }
    .card-value { font-size: 1.5rem; font-weight: 700; margin-top: 0.25rem; color: var(--accent); }
    table {
      width: 100%;
      border-collapse: collapse;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 10px;
      overflow: hidden;
      margin-bottom: 1.75rem;
    }
    th, td {
      padding: 0.75rem 0.9rem;
      border-bottom: 1px solid var(--border);
      text-align: left;
      font-size: 0.92rem;
    }
    th { font-weight: 600; color: var(--muted); }
    tr:last-child td { border-bottom: none; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.85em; }
    .badge {
      display: inline-block;
      padding: 0.15rem 0.55rem;
      border-radius: 999px;
      font-weight: 600;
      font-size: 0.78rem;
    }
    .badge-pass { background: var(--pass-bg); color: var(--pass-fg); }
    .badge-fail { background: var(--fail-bg); color: var(--fail-fg); }
    .badge-skip { background: var(--border); color: var(--muted); }
    .muted { color: var(--muted); }
  </style>
</head>
<body>
  <div class="container">
    <h1>commitbench A/B Benchmark Report</h1>
    <p class="meta">
      Run ID: <code>${escapeHtml(report.runId)}</code> |
      Generated: ${escapeHtml(report.createdAt)} |
      Test Command: <code>${escapeHtml(report.testCommand)}</code>
    </p>

    <div class="cards">
      <div class="card">
        <div class="card-label">Validated Tasks</div>
        <div class="card-value">${report.validTaskCount} / ${report.taskCount}</div>
      </div>
      <div class="card">
        <div class="card-label">Delta (B vs A)</div>
        <div class="card-value">${escapeHtml(formatDelta(report.deltaPassRate, "%", 1))}</div>
      </div>
      <div class="card">
        <div class="card-label">Winner</div>
        <div class="card-value">${escapeHtml(winnerText)}</div>
      </div>
      <div class="card">
        <div class="card-label">Git-Leak Audit</div>
        <div class="card-value">${report.leakViolationsTotal} violations</div>
      </div>
    </div>

    <h2>Variant Scorecard</h2>
    <table>
      <thead>
        <tr>
          <th>Variant</th>
          <th>Label</th>
          <th>Passed</th>
          <th>Pass Rate</th>
          <th>Fail-to-Pass</th>
          <th>Pass-to-Pass</th>
          <th>Avg Agent Time</th>
          <th>Leak Violations</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td><strong>${escapeHtml(varA.variantId)}</strong></td>
          <td>${escapeHtml(varA.variantLabel)}</td>
          <td>${varA.passedCount} / ${varA.totalCount}</td>
          <td>${varA.passRate.toFixed(1)}%</td>
          <td>${varA.failToPassCount} / ${varA.totalCount}</td>
          <td>${varA.passToPassCount} / ${varA.totalCount}</td>
          <td>${escapeHtml(formatDuration(varA.avgAgentDurationMs))}</td>
          <td>${varA.leakViolationsCount}</td>
        </tr>
        <tr>
          <td><strong>${escapeHtml(varB.variantId)}</strong></td>
          <td>${escapeHtml(varB.variantLabel)}</td>
          <td>${varB.passedCount} / ${varB.totalCount}</td>
          <td>${varB.passRate.toFixed(1)}%</td>
          <td>${varB.failToPassCount} / ${varB.totalCount}</td>
          <td>${varB.passToPassCount} / ${varB.totalCount}</td>
          <td>${escapeHtml(formatDuration(varB.avgAgentDurationMs))}</td>
          <td>${varB.leakViolationsCount}</td>
        </tr>
      </tbody>
    </table>

    <h2>Per-Task Breakdown</h2>
    <table>
      <thead>
        <tr>
          <th>Task ID</th>
          <th>Commit</th>
          <th>Variant A</th>
          <th>Variant B</th>
          <th>Subject</th>
          <th>Notes</th>
        </tr>
      </thead>
      <tbody>
        ${taskRows}
      </tbody>
    </table>
  </div>
</body>
</html>
`;
}
