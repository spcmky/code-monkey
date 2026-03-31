import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname, relative, resolve } from "node:path";
import logger from "../logger.js";
import { validatePath } from "../utils/path-safety.js";

export interface FileInfo {
  path: string;
  language: string;
  exports: string[];
  imports: string[];
  size: number;
}

export interface RepoMapData {
  files: FileInfo[];
  buildTimestamp: Date;
}

const LANGUAGE_MAP: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".rb": "ruby",
  ".sh": "bash",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".json": "json",
  ".md": "markdown",
};

const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  "__pycache__",
  ".next",
  "vendor",
]);

export class RepoMap {
  private cache = new Map<string, RepoMapData>();

  async build(repoPath: string): Promise<RepoMapData> {
    const resolvedRoot = resolve(repoPath);
    logger.info(`Building repo map for ${resolvedRoot}`);

    const files: FileInfo[] = [];
    this.walkDir(resolvedRoot, resolvedRoot, files);

    const mapData: RepoMapData = {
      files,
      buildTimestamp: new Date(),
    };

    this.cache.set(repoPath, mapData);
    logger.info(`Repo map built: ${files.length} files indexed`);
    return mapData;
  }

  getRelevantFiles(repoPath: string, query: string): FileInfo[] {
    const mapData = this.cache.get(repoPath);
    if (!mapData) {
      logger.warn(`No repo map cached for ${repoPath}`);
      return [];
    }

    // TODO: implement semantic search using embeddings
    // For now, simple keyword matching on paths and exports
    const queryLower = query.toLowerCase();
    const terms = queryLower.split(/\s+/);

    return mapData.files
      .map((file) => {
        const pathLower = file.path.toLowerCase();
        const exportsLower = file.exports.map((e) => e.toLowerCase());
        let score = 0;

        for (const term of terms) {
          if (pathLower.includes(term)) score += 2;
          if (exportsLower.some((e) => e.includes(term))) score += 3;
        }

        return { file, score };
      })
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .map(({ file }) => file);
  }

  getFileExports(repoPath: string, filePath: string): string[] {
    const mapData = this.cache.get(repoPath);
    if (!mapData) return [];

    const fileInfo = mapData.files.find((f) => f.path === filePath);
    return fileInfo?.exports ?? [];
  }

  private walkDir(
    rootPath: string,
    currentPath: string,
    files: FileInfo[]
  ): void {
    try {
      const entries = readdirSync(currentPath);
      for (const entry of entries) {
        if (IGNORE_DIRS.has(entry) || entry.startsWith(".")) continue;

        const fullPath = join(currentPath, entry);
        const stat = statSync(fullPath);

        if (stat.isDirectory()) {
          // Validate the directory stays within the root to prevent symlink traversal
          validatePath(relative(rootPath, fullPath), rootPath);
          this.walkDir(rootPath, fullPath, files);
        } else if (stat.isFile()) {
          const ext = extname(entry);
          const language = LANGUAGE_MAP[ext];
          if (!language) continue;

          const relPath = relative(rootPath, fullPath);
          const content = this.safeReadFile(fullPath);
          const exports = content
            ? this.extractExports(content, language)
            : [];
          const imports = content
            ? this.extractImports(content, language)
            : [];

          files.push({
            path: relPath,
            language,
            exports,
            imports,
            size: stat.size,
          });
        }
      }
    } catch (error) {
      logger.debug(`Error walking ${currentPath}: ${error}`);
    }
  }

  private safeReadFile(path: string): string | null {
    try {
      return readFileSync(path, "utf-8");
    } catch {
      return null;
    }
  }

  private extractExports(content: string, language: string): string[] {
    // TODO: use proper AST parsing per language
    const exports: string[] = [];

    if (language === "typescript" || language === "javascript") {
      const exportRegex =
        /export\s+(?:default\s+)?(?:class|function|const|let|var|interface|type|enum)\s+(\w+)/g;
      let match: RegExpExecArray | null;
      while ((match = exportRegex.exec(content)) !== null) {
        if (match[1]) exports.push(match[1]);
      }
    } else if (language === "python") {
      const defRegex = /^(?:def|class)\s+(\w+)/gm;
      let match: RegExpExecArray | null;
      while ((match = defRegex.exec(content)) !== null) {
        if (match[1]) exports.push(match[1]);
      }
    }

    return exports;
  }

  private extractImports(content: string, language: string): string[] {
    const imports: string[] = [];

    if (language === "typescript" || language === "javascript") {
      const importRegex = /import\s+.*?from\s+["'](.+?)["']/g;
      let match: RegExpExecArray | null;
      while ((match = importRegex.exec(content)) !== null) {
        if (match[1]) imports.push(match[1]);
      }
    }

    return imports;
  }
}
