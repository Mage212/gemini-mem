import { describe, expect, it } from 'vitest';
import { normalizeProjectPath } from '../src/core/paths';

describe('normalizeProjectPath', () => {
  it('resolves relative paths to absolute', () => {
    const result = normalizeProjectPath('.');
    expect(result.startsWith('/')).toBe(true);
    expect(result.endsWith('/')).toBe(false);
  });

  it('strips trailing slashes', () => {
    const a = normalizeProjectPath('/tmp/project');
    const b = normalizeProjectPath('/tmp/project/');
    const c = normalizeProjectPath('/tmp/project///');
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('rejects empty paths', () => {
    expect(() => normalizeProjectPath('')).toThrow(/required/);
    expect(() => normalizeProjectPath('   ')).toThrow(/required/);
  });
});
