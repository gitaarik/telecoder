import { describe, it, expect } from 'vitest';
import {
  CLAUDE_MODELS,
  filterModelsForVersion,
  isPassthroughModelId,
} from '../../src/claude/model-catalog.js';

const ids = (models: { id: string }[]) => models.map((m) => m.id);

describe('CLAUDE_MODELS', () => {
  it('covers every alias the CLI documents for --model', () => {
    expect(ids(CLAUDE_MODELS).sort()).toEqual(
      [
        'best',
        'fable',
        'fable[1m]',
        'haiku',
        'opus',
        'opus[1m]',
        'opusplan',
        'sonnet',
        'sonnet[1m]',
      ].sort(),
    );
  });

  it('gives every alias a description for the picker', () => {
    for (const model of CLAUDE_MODELS) {
      expect(model.description, model.id).toBeTruthy();
    }
  });

  it('uses lowercase ids — /model lowercases its argument before matching', () => {
    for (const model of CLAUDE_MODELS) {
      expect(model.id).toBe(model.id.toLowerCase());
    }
  });
});

describe('isPassthroughModelId', () => {
  it('accepts the full model IDs people actually pin', () => {
    for (const id of [
      'claude-opus-5',
      'claude-opus-4-8',
      'claude-haiku-4-5-20251001',
      'claude-opus-4-5@20251101', // Vertex dated snapshot
      'anthropic.claude-opus-5', // Bedrock
      'anthropic/claude-sonnet-5', // OpenRouter / CCR vendor prefix
      'deepseek,deepseek-reasoner', // CCR router syntax
      'anthropic.claude-3-5-sonnet-20241022-v2:0',
    ]) {
      expect(isPassthroughModelId(id), id).toBe(true);
    }
  });

  it('accepts every catalog alias, brackets included', () => {
    for (const model of CLAUDE_MODELS) {
      expect(isPassthroughModelId(model.id), model.id).toBe(true);
    }
  });

  it('rejects anything that could be read as a flag', () => {
    // `--model <value>` would swallow these as CLI flags rather than a name.
    for (const id of ['-p', '--dangerously-skip-permissions', '--model']) {
      expect(isPassthroughModelId(id), id).toBe(false);
    }
  });

  it('rejects values that would split or escape the argv entry', () => {
    for (const id of [
      'claude opus 5',
      'claude-opus-5 --debug',
      'claude\nopus',
      'claude;rm -rf /',
      '$(whoami)',
      '`whoami`',
      'claude-opus-5|tee',
      '',
    ]) {
      expect(isPassthroughModelId(id), JSON.stringify(id)).toBe(false);
    }
  });

  it('rejects absurdly long values', () => {
    expect(isPassthroughModelId('a'.repeat(100))).toBe(true);
    expect(isPassthroughModelId('a'.repeat(101))).toBe(false);
  });
});

describe('filterModelsForVersion', () => {
  it('keeps the full list when the binary knows fable', () => {
    expect(filterModelsForVersion(CLAUDE_MODELS, true)).toEqual(CLAUDE_MODELS);
  });

  it('drops both fable aliases on older binaries', () => {
    const filtered = ids(filterModelsForVersion(CLAUDE_MODELS, false));
    expect(filtered).not.toContain('fable');
    expect(filtered).not.toContain('fable[1m]');
  });

  it('leaves the pre-fable aliases alone', () => {
    // Exactly the set the SDK's bundled 2.1.140 binary accepts.
    expect(ids(filterModelsForVersion(CLAUDE_MODELS, false)).sort()).toEqual(
      ['best', 'haiku', 'opus', 'opus[1m]', 'opusplan', 'sonnet', 'sonnet[1m]'].sort(),
    );
  });
});
