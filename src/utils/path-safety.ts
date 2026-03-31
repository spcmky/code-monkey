import { resolve, normalize } from "node:path";

/**
 * Validates that a resolved path stays within the expected base directory.
 * Prevents path traversal attacks (e.g. ../../etc/passwd).
 */
export function validatePath(inputPath: string, baseDir: string): string {
  const normalizedBase = resolve(normalize(baseDir));
  const resolved = resolve(normalizedBase, normalize(inputPath));

  if (!resolved.startsWith(normalizedBase + "/") && resolved !== normalizedBase) {
    throw new Error(
      `Path traversal detected: "${inputPath}" resolves outside base directory`
    );
  }

  return resolved;
}
