import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { join } from "node:path";
import logger from "../logger.js";

const execFileAsync = promisify(execFile);

const SAFE_ARG_REGEX = /^[a-zA-Z0-9_/.@:%-]+$/;
const ALLOWED_LOG_FORMATS = new Set([
  "%H", "%h", "%s", "%an", "%ae", "%ad", "%cn", "%ce", "%cd",
  "%B", "%b", "%N", "%d", "%D", "%e", "%P", "%p", "%T", "%t",
  "oneline", "short", "medium", "full", "fuller", "reference",
  "format:%H %s", "format:%h %s", "format:%H|%an|%s|%ad",
]);

function validateGitArg(value: string, label: string): void {
  if (!SAFE_ARG_REGEX.test(value)) {
    throw new Error(
      `Invalid characters in git ${label}: "${value}". Only alphanumeric, _ / . @ : % - are allowed.`
    );
  }
}

function validateLogFormat(format: string): void {
  // Allow known safe formats, or formats composed only of safe format specifiers and separators
  if (ALLOWED_LOG_FORMATS.has(format)) return;
  // Allow custom format strings that only contain %<letter>, literals, and separators
  const safeFormatRegex = /^(format:)?[%a-zA-Z0-9 |,;:._/-]*$/;
  if (!safeFormatRegex.test(format)) {
    throw new Error(
      `Invalid git log format: "${format}". Use standard git format specifiers only.`
    );
  }
}

export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runGit(
  args: string[],
  cwd: string
): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (error: unknown) {
    const err = error as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? String(error),
      exitCode: err.code ?? 1,
    };
  }
}

export async function clone(
  repoUrl: string,
  destPath: string,
  options?: { depth?: number; branch?: string }
): Promise<GitResult> {
  validateGitArg(repoUrl, "repoUrl");
  validateGitArg(destPath, "destPath");
  logger.info(`Cloning ${repoUrl} to ${destPath}`);
  const args = ["clone"];
  if (options?.depth) args.push("--depth", String(options.depth));
  if (options?.branch) {
    validateGitArg(options.branch, "branch");
    args.push("--branch", options.branch);
  }
  args.push(repoUrl, destPath);

  const parentDir = join(destPath, "..");
  return runGit(args, parentDir);
}

export async function createBranch(
  repoPath: string,
  branchName: string
): Promise<GitResult> {
  validateGitArg(branchName, "branchName");
  logger.info(`Creating branch ${branchName} in ${repoPath}`);
  return runGit(["checkout", "-b", branchName], repoPath);
}

export async function checkout(
  repoPath: string,
  ref: string
): Promise<GitResult> {
  validateGitArg(ref, "ref");
  logger.info(`Checking out ${ref} in ${repoPath}`);
  return runGit(["checkout", ref], repoPath);
}

export async function commit(
  repoPath: string,
  message: string
): Promise<GitResult> {
  logger.info(`Committing in ${repoPath}`);
  await runGit(["add", "-A"], repoPath);
  return runGit(["commit", "-m", message], repoPath);
}

export async function push(
  repoPath: string,
  remote: string = "origin",
  branch?: string
): Promise<GitResult> {
  validateGitArg(remote, "remote");
  if (branch) validateGitArg(branch, "branch");
  const args = ["push", remote];
  if (branch) args.push(branch);
  logger.info(`Pushing to ${remote}/${branch ?? "HEAD"}`);
  return runGit(args, repoPath);
}

export async function diff(
  repoPath: string,
  base?: string
): Promise<GitResult> {
  if (base) validateGitArg(base, "base");
  const args = ["diff"];
  if (base) args.push(base);
  return runGit(args, repoPath);
}

export async function log(
  repoPath: string,
  options?: { maxCount?: number; format?: string }
): Promise<GitResult> {
  const args = ["log"];
  if (options?.maxCount) args.push(`-${options.maxCount}`);
  if (options?.format) {
    validateLogFormat(options.format);
    args.push(`--format=${options.format}`);
  }
  return runGit(args, repoPath);
}

export function repoExists(repoPath: string): boolean {
  return existsSync(join(repoPath, ".git"));
}
