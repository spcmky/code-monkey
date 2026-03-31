import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import logger from "../logger.js";

const execFileAsync = promisify(execFile);

export interface TestResult {
  passed: boolean;
  output: string;
  exitCode: number;
  summary?: string;
}

async function runCommand(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number = 300_000
): Promise<TestResult> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
      timeout: timeoutMs,
    });
    return {
      passed: true,
      output: stdout + stderr,
      exitCode: 0,
    };
  } catch (error: unknown) {
    const err = error as { stdout?: string; stderr?: string; code?: number };
    return {
      passed: false,
      output: (err.stdout ?? "") + (err.stderr ?? ""),
      exitCode: err.code ?? 1,
    };
  }
}

function detectPackageManager(
  repoPath: string
): "npm" | "yarn" | "pnpm" {
  if (existsSync(join(repoPath, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(repoPath, "yarn.lock"))) return "yarn";
  return "npm";
}

function getTestCommand(repoPath: string): { cmd: string; args: string[] } {
  const pkgPath = join(repoPath, "package.json");
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
      scripts?: Record<string, string>;
    };
    if (pkg.scripts?.test) {
      const pm = detectPackageManager(repoPath);
      return { cmd: pm, args: ["test"] };
    }
  }
  // TODO: support other languages (go test, pytest, etc.)
  return { cmd: "echo", args: ["No test command found"] };
}

export async function runTests(repoPath: string): Promise<TestResult> {
  logger.info(`Running tests in ${repoPath}`);
  const { cmd, args } = getTestCommand(repoPath);
  const result = await runCommand(cmd, args, repoPath);
  logger.info(`Tests ${result.passed ? "passed" : "failed"}`, {
    exitCode: result.exitCode,
  });
  return result;
}

export async function runLint(repoPath: string): Promise<TestResult> {
  logger.info(`Running lint in ${repoPath}`);
  const pm = detectPackageManager(repoPath);
  const result = await runCommand(pm, ["run", "lint"], repoPath);
  logger.info(`Lint ${result.passed ? "passed" : "failed"}`);
  return result;
}

export async function checkBuild(repoPath: string): Promise<TestResult> {
  logger.info(`Checking build in ${repoPath}`);
  const pm = detectPackageManager(repoPath);
  const result = await runCommand(pm, ["run", "build"], repoPath);
  logger.info(`Build ${result.passed ? "passed" : "failed"}`);
  return result;
}
