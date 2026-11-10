import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { ensureProjectDataDir } from '../../src/utils/project-data-dir.js';

let project = '';

beforeEach(() => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'telecoder-project-'));
});

afterEach(() => {
  fs.rmSync(project, { recursive: true, force: true });
});

describe('ensureProjectDataDir', () => {
  it('makes <project>/.telecoder/<sub>, owner-only, and returns it', () => {
    const dir = ensureProjectDataDir(project, 'uploads');
    expect(dir).toBe(path.join(project, '.telecoder', 'uploads'));
    expect(fs.statSync(dir).isDirectory()).toBe(true);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('gives the folder a .gitignore that ignores all of it', () => {
    ensureProjectDataDir(project, 'uploads');
    const ignore = fs.readFileSync(path.join(project, '.telecoder', '.gitignore'), 'utf-8');
    expect(ignore.split('\n')).toContain('*');
  });

  it('keeps sent files out of git without the project ignoring anything', () => {
    execFileSync('git', ['init', '-q'], { cwd: project });
    fs.writeFileSync(path.join(ensureProjectDataDir(project, 'uploads'), 'photo.jpg'), 'x');
    fs.writeFileSync(path.join(ensureProjectDataDir(project, 'handoffs'), 'handoff-1.md'), 'x');
    fs.writeFileSync(path.join(project, 'README.md'), 'x');

    const untracked = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: project, encoding: 'utf-8' });
    expect(untracked.trim().split('\n')).toEqual(['?? README.md']);
  });

  it('leaves a .gitignore someone edited alone', () => {
    fs.mkdirSync(path.join(project, '.telecoder'));
    fs.writeFileSync(path.join(project, '.telecoder', '.gitignore'), 'uploads/\n');
    ensureProjectDataDir(project, 'uploads');
    expect(fs.readFileSync(path.join(project, '.telecoder', '.gitignore'), 'utf-8')).toBe('uploads/\n');
  });
});
