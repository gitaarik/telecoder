import { describe, it, expect } from 'vitest';
import { nodeVersionProblem } from '../src/node-version-check.js';

describe('nodeVersionProblem', () => {
  it.each(['v22.0.0', 'v22.22.0', 'v24.1.0', 'v30.0.0'])('accepts %s', (version) => {
    expect(nodeVersionProblem(version)).toBeUndefined();
  });

  it.each(['v20.11.1', 'v18.19.0', 'v21.7.3'])('turns down %s, naming both versions', (version) => {
    const problem = nodeVersionProblem(version);
    expect(problem).toContain('Node.js 22 or newer');
    expect(problem).toContain(version);
  });
});
