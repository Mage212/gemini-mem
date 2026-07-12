import path from 'path';

/**
 * Normalize a project path so the same directory always maps to one memory bucket.
 * - Resolves to an absolute path
 * - Strips trailing separators (except root)
 */
export function normalizeProjectPath(projectPath: string): string {
  if (!projectPath || !projectPath.trim()) {
    throw new Error('projectPath is required');
  }
  const resolved = path.resolve(projectPath.trim());
  if (resolved === path.parse(resolved).root) {
    return resolved;
  }
  return resolved.replace(/[/\\]+$/, '');
}
