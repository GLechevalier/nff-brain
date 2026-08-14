import { describe, expect, it } from 'vitest';
import { CODE_PATH_MAX_DEPTH, joinJailedPath, resolveJailedPath } from '../src/codePath.js';

describe('resolveJailedPath', () => {
  it('accepts ordinary relative paths', () => {
    expect(resolveJailedPath('src/index.ts')).toEqual(['src', 'index.ts']);
    expect(resolveJailedPath('README.md')).toEqual(['README.md']);
    expect(resolveJailedPath('a b/c-d_e.txt')).toEqual(['a b', 'c-d_e.txt']);
  });

  it('normalizes backslashes, ./, doubled and trailing slashes', () => {
    expect(resolveJailedPath('src\\lib\\x.ts')).toEqual(['src', 'lib', 'x.ts']);
    expect(resolveJailedPath('./src/x.ts')).toEqual(['src', 'x.ts']);
    expect(resolveJailedPath('src//x.ts')).toEqual(['src', 'x.ts']);
    expect(resolveJailedPath('src/x.ts/')).toEqual(['src', 'x.ts']);
    expect(resolveJailedPath('src/./x.ts')).toEqual(['src', 'x.ts']);
  });

  it('rejects every escape shape', () => {
    expect(resolveJailedPath('../outside.txt')).toBeNull();
    expect(resolveJailedPath('a/../../b')).toBeNull();
    expect(resolveJailedPath('a/..')).toBeNull();
    expect(resolveJailedPath('/etc/passwd')).toBeNull();
    expect(resolveJailedPath('C:\\Windows\\system32')).toBeNull();
    expect(resolveJailedPath('c:/x')).toBeNull();
    expect(resolveJailedPath('~/secrets')).toBeNull();
  });

  it('rejects .git as the first segment but allows it deeper as a name', () => {
    expect(resolveJailedPath('.git/config')).toBeNull();
    expect(resolveJailedPath('.git')).toBeNull();
    // A file merely NAMED like it deeper down is not the repository store.
    expect(resolveJailedPath('docs/.gitignore')).toEqual(['docs', '.gitignore']);
  });

  it('rejects junk: non-strings, empties, control chars, absurd depth', () => {
    expect(resolveJailedPath(undefined)).toBeNull();
    expect(resolveJailedPath(42)).toBeNull();
    expect(resolveJailedPath('')).toBeNull();
    expect(resolveJailedPath('   ')).toBeNull();
    expect(resolveJailedPath('.')).toBeNull(); // resolves to zero segments
    expect(resolveJailedPath('a/\u0000b/c')).toBeNull();
    expect(resolveJailedPath(Array(CODE_PATH_MAX_DEPTH + 2).fill('d').join('/'))).toBeNull();
  });
});

describe('joinJailedPath', () => {
  it('round-trips with forward slashes', () => {
    expect(joinJailedPath(resolveJailedPath('src\\a\\b.ts')!)).toBe('src/a/b.ts');
  });
});
