import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mineTasks } from "../git/miner.js";
import { compareVariants } from "../runner/compare.js";
import type { CompareReport, VariantSpec } from "../types.js";

export interface DemoFixture {
  rootDir: string;
  repoDir: string;
  agentAScript: string;
  agentBScript: string;
  testCommand: string;
  variantA: VariantSpec;
  variantB: VariantSpec;
  cleanup: () => void;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function writeFilesAndCommit(
  repoDir: string,
  files: Record<string, string>,
  message: string,
): void {
  for (const [relPath, content] of Object.entries(files)) {
    const absPath = path.join(repoDir, relPath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, content, "utf8");
  }
  git(repoDir, ["add", "-A"]);
  git(repoDir, ["commit", "-m", message, "--no-verify"]);
}

const BASE_PRICING = `export function calculateTotal(items, discountPercent = 0) {
  let subtotal = 0;
  for (const item of items) {
    subtotal += item.price * item.qty;
  }
  const discounted = subtotal * (1 - discountPercent / 100);
  return Math.round(discounted * 100) / 100;
}
`;

const FIXED_PRICING = `export function calculateTotal(items, discountPercent = 0) {
  let subtotal = 0;
  for (const item of items) {
    if (item.price < 0 || item.qty < 0) {
      throw new RangeError("Item price and quantity must be non-negative");
    }
    subtotal += item.price * item.qty;
  }
  const clampedDiscount = Math.min(100, Math.max(0, discountPercent));
  const discounted = subtotal * (1 - clampedDiscount / 100);
  const rounded = Math.round((discounted + Number.EPSILON) * 100) / 100;
  return Math.max(0, rounded);
}
`;

const BASE_PRICING_TEST = `import test from "node:test";
import assert from "node:assert/strict";
import { calculateTotal } from "../src/pricing.mjs";

test("calculates basic cart total with percentage discount", () => {
  const total = calculateTotal(
    [
      { price: 20, qty: 2 },
      { price: 10, qty: 1 },
    ],
    10,
  );
  assert.equal(total, 45);
});
`;

const FIXED_PRICING_TEST = `import test from "node:test";
import assert from "node:assert/strict";
import { calculateTotal } from "../src/pricing.mjs";

test("calculates basic cart total with percentage discount", () => {
  const total = calculateTotal(
    [
      { price: 20, qty: 2 },
      { price: 10, qty: 1 },
    ],
    10,
  );
  assert.equal(total, 45);
});

test("clamps discounts above 100 percent to zero and rejects negative prices", () => {
  assert.equal(calculateTotal([{ price: 19.99, qty: 1 }], 150), 0);
  assert.equal(calculateTotal([{ price: 19.99, qty: 1 }], -20), 19.99);
  assert.throws(() => calculateTotal([{ price: -5, qty: 1 }], 0), RangeError);
});
`;

const BASE_AUTH = `export function parseBearerHeader(headerValue) {
  if (typeof headerValue !== "string") {
    return null;
  }
  if (!headerValue.startsWith("Bearer ")) {
    return null;
  }
  return headerValue.slice(7).trim() || null;
}

export function isSessionActive(session, nowMs) {
  if (!session || typeof session.expiresAt !== "number") {
    return false;
  }
  return nowMs <= session.expiresAt;
}
`;

const FIXED_AUTH = `export function parseBearerHeader(headerValue) {
  if (typeof headerValue !== "string") {
    return null;
  }
  const match = headerValue.trim().match(/^bearer\\s+([^\\s]+)$/i);
  return match ? match[1] : null;
}

export function isSessionActive(session, nowMs) {
  if (!session || typeof session.expiresAt !== "number" || !Number.isFinite(nowMs)) {
    return false;
  }
  if (session.revoked === true) {
    return false;
  }
  return nowMs < session.expiresAt;
}
`;

const BASE_AUTH_TEST = `import test from "node:test";
import assert from "node:assert/strict";
import { parseBearerHeader, isSessionActive } from "../src/auth.mjs";

test("parses standard Bearer token and active session", () => {
  assert.equal(parseBearerHeader("Bearer tok_123"), "tok_123");
  assert.equal(isSessionActive({ expiresAt: 2000 }, 1000), true);
  assert.equal(isSessionActive({ expiresAt: 1000 }, 2000), false);
});
`;

const FIXED_AUTH_TEST = `import test from "node:test";
import assert from "node:assert/strict";
import { parseBearerHeader, isSessionActive } from "../src/auth.mjs";

test("parses standard Bearer token and active session", () => {
  assert.equal(parseBearerHeader("Bearer tok_123"), "tok_123");
  assert.equal(isSessionActive({ expiresAt: 2000 }, 1000), true);
  assert.equal(isSessionActive({ expiresAt: 1000 }, 2000), false);
});

test("handles case-insensitive bearer scheme, exact expiry boundary, and revoked sessions", () => {
  assert.equal(parseBearerHeader("  bearer   tok_abc  "), "tok_abc");
  assert.equal(parseBearerHeader("Bearer tok with spaces"), null);
  assert.equal(isSessionActive({ expiresAt: 1000 }, 1000), false);
  assert.equal(isSessionActive({ expiresAt: 2000, revoked: true }, 1000), false);
});
`;

const BASE_SLUG = `export function toSlug(input) {
  return String(input)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-");
}
`;

const FIXED_SLUG = `export function toSlug(input) {
  return String(input)
    .normalize("NFKD")
    .replace(/[\\u0300-\\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
`;

const BASE_SLUG_TEST = `import test from "node:test";
import assert from "node:assert/strict";
import { toSlug } from "../src/slug.mjs";

test("converts simple title into lowercase hyphenated slug", () => {
  assert.equal(toSlug("Hello World"), "hello-world");
});
`;

const FIXED_SLUG_TEST = `import test from "node:test";
import assert from "node:assert/strict";
import { toSlug } from "../src/slug.mjs";

test("converts simple title into lowercase hyphenated slug", () => {
  assert.equal(toSlug("Hello World"), "hello-world");
});

test("strips diacritics and trims leading or trailing hyphens from punctuation", () => {
  assert.equal(toSlug("  Cafe Creme!!  "), "cafe-creme");
  assert.equal(toSlug("Cr\\u00e8me Br\\u00fbl\\u00e9e --- 2026!"), "creme-brulee-2026");
});
`;

function buildSimulatedAgentScript(mode: "baseline" | "improved"): string {
  return `import fs from "node:fs";
import path from "node:path";

const promptFile = process.env.COMMITBENCH_PROMPT_FILE;
const workdir = process.env.COMMITBENCH_WORKDIR || process.cwd();
const prompt = promptFile && fs.existsSync(promptFile)
  ? fs.readFileSync(promptFile, "utf8").toLowerCase()
  : "";

const MODE = ${JSON.stringify(mode)};

const FIXED_PRICING = ${JSON.stringify(FIXED_PRICING)};
const PARTIAL_PRICING = \`export function calculateTotal(items, discountPercent = 0) {
  let subtotal = 0;
  for (const item of items) {
    subtotal += item.price * item.qty;
  }
  const discounted = subtotal * (1 - discountPercent / 100);
  return Math.max(0, Math.round(discounted * 100) / 100);
}
\`;

const FIXED_AUTH = ${JSON.stringify(FIXED_AUTH)};
const FIXED_SLUG = ${JSON.stringify(FIXED_SLUG)};

if (prompt.includes("slug") || prompt.includes("diacritic") || prompt.includes("hyphen")) {
  fs.writeFileSync(path.join(workdir, "src", "slug.mjs"), FIXED_SLUG, "utf8");
} else if (prompt.includes("discount") || prompt.includes("coupon") || prompt.includes("negative")) {
  if (MODE === "improved") {
    fs.writeFileSync(path.join(workdir, "src", "pricing.mjs"), FIXED_PRICING, "utf8");
  } else {
    // Baseline agent clamps total to >= 0 but misses negative item price validation and negative discounts.
    fs.writeFileSync(path.join(workdir, "src", "pricing.mjs"), PARTIAL_PRICING, "utf8");
  }
} else if (prompt.includes("bearer") || prompt.includes("session") || prompt.includes("expir")) {
  if (MODE === "improved") {
    fs.writeFileSync(path.join(workdir, "src", "auth.mjs"), FIXED_AUTH, "utf8");
  } else {
    // Baseline agent leaves auth boundary and revoked flag unhandled.
  }
}
`;
}

export function createDemoFixture(baseTempDir?: string): DemoFixture {
  const parent = baseTempDir ? path.resolve(baseTempDir) : os.tmpdir();
  fs.mkdirSync(parent, { recursive: true });
  const rootDir = fs.mkdtempSync(path.join(parent, "commitbench-demo-"));
  const repoDir = path.join(rootDir, "sample-repo");
  fs.mkdirSync(repoDir, { recursive: true });

  git(repoDir, ["init", "-b", "main"]);
  fs.appendFileSync(
    path.join(repoDir, ".git", "config"),
    "\n[user]\n\tname = Demo Maintainer\n\temail = maintainer@example.local\n[core]\n\tautocrlf = false\n",
    "utf8",
  );

  // Add a fake remote and tag so leak-proof verification actively proves they are stripped.
  git(repoDir, ["remote", "add", "origin", "https://example.invalid/demo/sample-repo.git"]);

  // Base commit: all modules and baseline tests pass.
  writeFilesAndCommit(
    repoDir,
    {
      "package.json": JSON.stringify({ name: "demo-app", type: "module" }, null, 2) + "\n",
      "src/pricing.mjs": BASE_PRICING,
      "src/auth.mjs": BASE_AUTH,
      "src/slug.mjs": BASE_SLUG,
      "tests/pricing.test.mjs": BASE_PRICING_TEST,
      "tests/auth.test.mjs": BASE_AUTH_TEST,
      "tests/slug.test.mjs": BASE_SLUG_TEST,
    },
    "chore: initial baseline modules and tests",
  );
  git(repoDir, ["tag", "v0.1.0"]);

  // Commit 1: Pricing discount clamping and negative price bug fix.
  writeFilesAndCommit(
    repoDir,
    {
      "src/pricing.mjs": FIXED_PRICING,
      "tests/pricing.test.mjs": FIXED_PRICING_TEST,
    },
    "fix: clamp discount percentages above 100 and reject negative item prices in src/pricing.mjs",
  );

  // Decoy commit: docs only (miner must ignore it).
  writeFilesAndCommit(
    repoDir,
    {
      "README.md": "# Demo App\n\nSample repository for commitbench demo.\n",
    },
    "docs: add README overview",
  );

  // Commit 2: Auth bearer case sensitivity, exact expiry boundary, and revoked flag fix.
  writeFilesAndCommit(
    repoDir,
    {
      "src/auth.mjs": FIXED_AUTH,
      "tests/auth.test.mjs": FIXED_AUTH_TEST,
    },
    "fix: accept case-insensitive bearer headers and reject expired or revoked sessions in src/auth.mjs",
  );

  // Commit 3: Slug diacritics and trailing hyphen fix.
  writeFilesAndCommit(
    repoDir,
    {
      "src/slug.mjs": FIXED_SLUG,
      "tests/slug.test.mjs": FIXED_SLUG_TEST,
    },
    "fix: normalize unicode diacritics and trim edge hyphens in URL slugs in src/slug.mjs",
  );
  git(repoDir, ["tag", "v0.2.0"]);

  const agentAScript = path.join(rootDir, "agent-a.mjs");
  const agentBScript = path.join(rootDir, "agent-b.mjs");
  fs.writeFileSync(agentAScript, buildSimulatedAgentScript("baseline"), "utf8");
  fs.writeFileSync(agentBScript, buildSimulatedAgentScript("improved"), "utf8");

  const nodeExec = `"${process.execPath}"`;
  const variantA: VariantSpec = {
    id: "A",
    label: "Baseline prompt",
    command: `${nodeExec} "${agentAScript}"`,
  };
  const variantB: VariantSpec = {
    id: "B",
    label: "Improved AGENTS.md",
    command: `${nodeExec} "${agentBScript}"`,
  };

  return {
    rootDir,
    repoDir,
    agentAScript,
    agentBScript,
    testCommand: `${nodeExec} --test`,
    variantA,
    variantB,
    cleanup: () => {
      fs.rmSync(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

export async function runDemo(options?: { baseTempDir?: string }): Promise<CompareReport> {
  const fixture = createDemoFixture(options?.baseTempDir);
  try {
    const tasks = mineTasks({
      repoPath: fixture.repoDir,
      days: 45,
      limit: 15,
    });

    const dbPath = path.join(fixture.rootDir, "demo-runs.sqlite");
    const report = await compareVariants({
      repoPath: fixture.repoDir,
      tasks,
      variantA: fixture.variantA,
      variantB: fixture.variantB,
      testCommand: fixture.testCommand,
      concurrency: 2,
      agentTimeoutMs: 30_000,
      testTimeoutMs: 30_000,
      validateFirst: true,
      dbPath,
      baseTempDir: fixture.rootDir,
    });

    return { ...report, dbPath: undefined };
  } finally {
    fixture.cleanup();
  }
}
