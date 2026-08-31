import { describe, it, expect } from 'vitest';
import { parseCostOutput } from '../../src/bot/handlers/command/cost.js';

/** Real `claude -p /cost` output on a subscription account (2.1.251). */
const SUBSCRIPTION_OUTPUT = `You are currently using your subscription to power your Claude Code usage

Current session: 39% used · resets Aug 31, 5:09pm (UTC)
Current week (all models): 13% used · resets Sep 5, 7:59pm (UTC)
Current week (Fable): 0% used

What's contributing to your limits usage?
Approximate, based on local sessions on this machine — does not include other devices or claude.ai.

Last 24h · 1608 requests · 89 sessions
  70% of your usage was at >150k context
  42% of your usage was while 4+ sessions ran in parallel

Last 7d · 8833 requests · 627 sessions
  Top skills: /frontend-design:frontend-design 1%`;

/** The shape an API-billed account gets instead. */
const BILLING_OUTPUT = `Total cost:            $0.1234
Total duration (API):  1m 23.4s
Total duration (wall): 5m 12.3s
Total code changes:    42 lines added, 7 lines removed
Usage by model:
    claude-opus-5:  15.0k input, 2.1k output, 1.5m cache read`;

describe('parseCostOutput', () => {
  it('reports a warning for empty output', () => {
    expect(parseCostOutput('   ')).toBe('⚠️ No cost output received.');
  });

  it('turns each limit line into a progress bar with its reset time', () => {
    const out = parseCostOutput(SUBSCRIPTION_OUTPUT);
    expect(out).toContain('**39%** session — resets Aug 31, 5:09pm (UTC)');
    expect(out).toContain('**13%** week (all models) — resets Sep 5, 7:59pm (UTC)');
    // No reset clause on this one — it must not invent one.
    expect(out).toContain('**0%** week (Fable)');
    expect(out).not.toContain('**0%** week (Fable) —');
  });

  it('colour-codes the bar by how much of the limit is gone', () => {
    expect(parseCostOutput('Current session: 39% used')).toContain('🟢');
    expect(parseCostOutput('Current session: 72% used')).toContain('🟡');
    expect(parseCostOutput('Current session: 91% used')).toContain('🔴');
  });

  it('keeps the per-period headings and bullets their detail rows', () => {
    const out = parseCostOutput(SUBSCRIPTION_OUTPUT);
    expect(out).toContain('**Last 24h** · 1608 requests · 89 sessions');
    expect(out).toContain('- 70% of your usage was at >150k context');
    expect(out).toContain('- Top skills: /frontend-design:frontend-design 1%');
  });

  it('keeps the caveat about the numbers being local-only', () => {
    expect(parseCostOutput(SUBSCRIPTION_OUTPUT))
      .toContain('_Approximate, based on local sessions on this machine — does not include other devices or claude.ai._');
  });

  it('formats the API-billing shape as labelled bullets', () => {
    const out = parseCostOutput(BILLING_OUTPUT);
    expect(out).toContain('- **Total cost:** $0.1234');
    expect(out).toContain('- **Total duration (API):** 1m 23.4s');
    expect(out).toContain('- **Total code changes:** 42 lines added, 7 lines removed');
    expect(out).toContain('**Usage by model**');
    expect(out).toContain('- claude-opus-5:  15.0k input, 2.1k output, 1.5m cache read');
  });

  it('qualifies the dollar totals rather than passing off a fresh probe as the chat\'s spend', () => {
    // The CLI's cost counter dies with the process that spent it — a resumed
    // session reports zero — so an unqualified $0.00 would read as a free
    // conversation. The subscription shape has no such totals to qualify.
    expect(parseCostOutput(BILLING_OUTPUT)).toContain('_Totals cover this lookup only');
    expect(parseCostOutput(SUBSCRIPTION_OUTPUT)).not.toContain('Totals cover this lookup only');
  });

  it('falls back to a fenced raw block when nothing parses', () => {
    const out = parseCostOutput('some future wording\nwe have never seen');
    expect(out).toContain('## 💰 Cost & Usage');
    expect(out).toContain('```');
    expect(out).toContain('some future wording');
  });

  it('renders a one-line answer as a sentence, not a code block', () => {
    // What a CLI a few releases old replies with — the SDK's bundled copy
    // (2.1.140) says exactly this and nothing else.
    const out = parseCostOutput('You are currently using your subscription to power your Claude Code usage');
    expect(out).toContain('_You are currently using your subscription to power your Claude Code usage_');
    expect(out).not.toContain('```');
  });

  it('still reports the tally when the CLI output is unrecognised', () => {
    const out = parseCostOutput('some future wording', { usd: 0.5, turns: 3 });
    expect(out).toContain('**This chat:** $0.5000 across 3 turns');
  });

  it("appends TeleCoder's own tally for the conversation", () => {
    const out = parseCostOutput(SUBSCRIPTION_OUTPUT, { usd: 0.4212, turns: 7 });
    expect(out).toContain('**This chat:** $0.4212 across 7 turns');
  });

  it('counts a single turn in the singular', () => {
    expect(parseCostOutput(SUBSCRIPTION_OUTPUT, { usd: 0.05, turns: 1 })).toContain('across 1 turn —');
  });

  it('omits the tally when no turn has been recorded', () => {
    // Every PTY-mode chat: that mode never receives a cost figure to add up.
    expect(parseCostOutput(SUBSCRIPTION_OUTPUT, { usd: 0, turns: 0 })).not.toContain('This chat:');
    expect(parseCostOutput(SUBSCRIPTION_OUTPUT)).not.toContain('This chat:');
  });

  it('never opens with a blank line or doubles one up', () => {
    const out = parseCostOutput(SUBSCRIPTION_OUTPUT);
    expect(out.split('\n')[2]).not.toBe('');
    expect(out).not.toContain('\n\n\n');
  });
});
