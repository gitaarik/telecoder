/**
 * The launcher's tally for /rebuildbot's "when idle" option: which instances
 * have restarted onto the new build, which are still finishing something and
 * what, and the status message that says so.
 *
 * Bookkeeping only — the launcher does the restarting and the messaging, and
 * src/restart-when-idle.ts is the workers' end. Kept apart from the launcher,
 * like prefs-relay.ts, because the launcher runs its code at import.
 */

export interface IdleRestartOrigin {
  /** The instance whose chat holds the status message. */
  instance: string;
  chatId: number;
  messageId: number;
  /** Said under the tally the whole way through — the stale-launcher warning. */
  note?: string;
}

export interface IdleRestartRender {
  text: string;
  /** Whether the message still offers "restart the rest now" and "cancel". */
  buttons: boolean;
}

export class IdleRestart {
  /** Instances still to restart, with what each last said it was doing. */
  private readonly waiting = new Map<string, string>();
  private readonly restarted: string[] = [];
  private readonly forced: string[] = [];
  /** Set by cancel(): the instances it left on the old build. */
  private leftOnCancel: string[] | null = null;
  private superseded = false;

  constructor(readonly origin: IdleRestartOrigin, instances: string[]) {
    for (const name of instances) this.waiting.set(name, '');
  }

  isWaitingOn(name: string): boolean {
    return this.waiting.has(name);
  }

  waitingOn(): string[] {
    return [...this.waiting.keys()];
  }

  /** Record what an instance says it is still doing. False if not waiting on it. */
  busy(name: string, detail: string): boolean {
    if (!this.waiting.has(name)) return false;
    this.waiting.set(name, detail);
    return true;
  }

  /** An instance is going. False if it had already gone. */
  restarting(name: string, opts: { forced?: boolean } = {}): boolean {
    if (!this.waiting.delete(name)) return false;
    this.restarted.push(name);
    if (opts.forced) this.forced.push(name);
    return true;
  }

  /** Stop waiting. Returns the instances left on the old build. */
  cancel(): string[] {
    const left = this.waitingOn();
    this.waiting.clear();
    this.leftOnCancel = left;
    return left;
  }

  /** A newer rebuild took over; this message only needs closing. */
  supersede(): void {
    this.superseded = true;
  }

  isFinished(): boolean {
    return this.leftOnCancel !== null || this.superseded || this.waiting.size === 0;
  }

  render(): IdleRestartRender {
    const note = this.origin.note ? `\n\n${this.origin.note}` : '';
    const done = this.restarted.join(', ');

    if (this.superseded) {
      return { text: `🔄 Superseded by a newer rebuild.${done ? `\n\n✅ Restarted: ${done}` : ''}`, buttons: false };
    }

    if (this.leftOnCancel) {
      const left = this.leftOnCancel;
      return {
        text: '✖️ Restart cancelled.'
          + (done ? `\n\n✅ Restarted: ${done}` : '')
          + (left.length ? `\n⏸ Still on the old build: ${left.join(', ')}` : '')
          + note,
        buttons: false,
      };
    }

    if (this.waiting.size === 0) {
      const count = this.restarted.length;
      const forced = this.forced.length ? ` (${this.forced.join(', ')} without waiting)` : '';
      return {
        text: `✅ ${count === 1 ? 'The bot is' : `All ${count} bots are`} on the new build${forced}.\n\n${done}${note}`,
        buttons: false,
      };
    }

    const lines = ['🔄 Restarting each bot on the new build once it has nothing left to finish.', ''];
    if (done) lines.push(`✅ ${done}`);
    for (const [name, detail] of this.waiting) lines.push(`⏳ ${name} — ${detail || 'checking'}`);
    return { text: lines.join('\n') + note, buttons: true };
  }
}
