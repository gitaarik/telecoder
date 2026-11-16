import { describe, it, expect } from 'vitest';
import {
  CLAUDE_MODELS,
  describeModelId,
  filterModelsForVersion,
  findModelUsageKey,
  isPassthroughModelId,
  isPremiumModel,
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

describe('isPremiumModel', () => {
  it('flags the fable aliases and the IDs the API reports for them', () => {
    for (const m of ['fable', 'fable[1m]', 'claude-fable-5-1', 'anthropic/claude-fable-5-1']) {
      expect(isPremiumModel(m)).toBe(true);
    }
  });

  it('leaves every other model alone', () => {
    for (const m of ['opus', 'opus[1m]', 'sonnet', 'haiku', 'best', 'claude-opus-5-5', undefined, '']) {
      expect(isPremiumModel(m)).toBe(false);
    }
  });
});

describe('findModelUsageKey', () => {
  it("picks the reply's model over a Haiku side call listed first", () => {
    const usage = { 'claude-haiku-4-5-20251001': {}, 'claude-opus-5-5': {} };
    expect(findModelUsageKey(usage, 'claude-opus-5-5')).toBe('claude-opus-5-5');
  });

  it('matches a key carrying a context suffix', () => {
    const usage = { 'claude-haiku-4-5-20251001': {}, 'claude-opus-5-5[1m]': {} };
    expect(findModelUsageKey(usage, 'claude-opus-5-5')).toBe('claude-opus-5-5[1m]');
  });

  it('matches an alias key by its canonical model', () => {
    const usage = { 'claude-haiku-4-5-20251001': {}, opus: { canonicalModel: 'claude-opus-5-5' } };
    expect(findModelUsageKey(usage, 'claude-opus-5-5')).toBe('opus');
  });

  it('falls back on the first entry', () => {
    expect(findModelUsageKey({ a: {}, b: {} }, 'c')).toBe('a');
  });
});

describe('describeModelId', () => {
  it('names a Claude id by family and version', () => {
    expect(describeModelId('claude-fable-5-1')).toBe('Fable 5.1');
    expect(describeModelId('claude-opus-4-8')).toBe('Opus 4.8');
    expect(describeModelId('claude-sonnet-4-5-20250929')).toBe('Sonnet 4.5');
    expect(describeModelId('claude-3-5-haiku-20241022')).toBe('Haiku 3.5');
    expect(describeModelId('anthropic/claude-opus-4-5@20251101')).toBe('Opus 4.5');
  });

  it('leaves any other backend as its vendor names it', () => {
    expect(describeModelId('deepseek-reasoner')).toBe('deepseek-reasoner');
    expect(describeModelId('openrouter,google/gemini-2.5-pro')).toBe('openrouter,google/gemini-2.5-pro');
  });
});
