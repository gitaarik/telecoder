import * as path from 'path';
import { z } from 'zod';
import { Cron } from 'croner';
import { ensureStateDir, getStateDir, readJsonFile, writeJsonFile } from '../utils/json-store.js';
import { BOT_ID } from '../config.js';

/**
 * Persistent scheduler for /schedule Telegram commands. Schedules survive
 * bot restarts via ~/.claudegram/schedules-<BOT_ID>.json; in-memory timers
 * are re-armed on loadAll(). Hard caps enforced at create time so a user
 * can't accidentally cron themselves into a runaway billing crater.
 */

export const HARD_LIMITS = {
  MAX_PER_SESSION: 10,
  MIN_INTERVAL_MS: 60_000,
  DEFAULT_MAX_RUNS: 50,
  MAX_MAX_RUNS: 500,
  MAX_CONSECUTIVE_FAILURES: 3,
} as const;

const scheduleSchema = z.object({
  id: z.string(),
  sessionKey: z.string(),
  cwd: z.string(),
  claudeSessionId: z.string().optional(),
  prompt: z.string(),
  label: z.string().optional(),
  kind: z.enum(['interval', 'cron']),
  intervalMs: z.number().optional(),
  cronExpr: z.string().optional(),
  maxRuns: z.number(),
  runs: z.number(),
  consecutiveFailures: z.number(),
  disabled: z.boolean(),
  createdAt: z.string(),
  lastFiredAt: z.string().optional(),
});

const scheduleFileSchema = z.object({
  schedules: z.array(scheduleSchema),
});

export type Schedule = z.infer<typeof scheduleSchema>;

export interface ScheduleSpec {
  sessionKey: string;
  cwd: string;
  claudeSessionId?: string;
  prompt: string;
  label?: string;
  kind: 'interval' | 'cron';
  intervalMs?: number;
  cronExpr?: string;
  maxRuns?: number;
}

export type FireHandler = (schedule: Schedule) => Promise<void>;

const HISTORY_DIR = getStateDir();

function getFile(): string {
  return path.join(HISTORY_DIR, `schedules-${BOT_ID}.json`);
}

function genId(): string {
  return `sch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

class Scheduler {
  private schedules: Map<string, Schedule> = new Map();
  private intervalTimers: Map<string, NodeJS.Timeout> = new Map();
  private cronJobs: Map<string, Cron> = new Map();
  private fireHandler: FireHandler | null = null;
  private loaded = false;

  /** Re-arm all persisted schedules. Idempotent. Pass the handler that runs
   * when a schedule fires — defining it outside this module avoids the
   * scheduler→runner→provider dependency cycle. */
  loadAll(handler: FireHandler): void {
    this.fireHandler = handler;
    if (this.loaded) {
      this.armAll();
      return;
    }
    this.loaded = true;

    const loaded = readJsonFile(getFile(), scheduleFileSchema, 'Scheduler');
    if (!loaded) return;
    for (const s of loaded.schedules) {
      this.schedules.set(s.id, s);
    }
    this.armAll();
    console.log(`[Scheduler] loaded ${this.schedules.size} schedule(s)`);
  }

  createSchedule(spec: ScheduleSpec): Schedule {
    const existing = this.listSchedules(spec.sessionKey).filter((s) => !s.disabled);
    if (existing.length >= HARD_LIMITS.MAX_PER_SESSION) {
      throw new Error(
        `Schedule cap reached for this chat (${HARD_LIMITS.MAX_PER_SESSION} active). ` +
          `Delete one with /unschedule before adding another.`,
      );
    }

    if (spec.kind === 'interval') {
      if (!spec.intervalMs || spec.intervalMs < HARD_LIMITS.MIN_INTERVAL_MS) {
        throw new Error(`Interval must be at least ${HARD_LIMITS.MIN_INTERVAL_MS / 1000}s.`);
      }
    } else {
      if (!spec.cronExpr) {
        throw new Error('Cron expression is required for cron schedules.');
      }
      try {
        new Cron(spec.cronExpr);
      } catch (err) {
        throw new Error(`Invalid cron expression: ${err instanceof Error ? err.message : err}`);
      }
    }

    const maxRunsRequested = spec.maxRuns ?? HARD_LIMITS.DEFAULT_MAX_RUNS;
    const maxRuns = Math.max(1, Math.min(HARD_LIMITS.MAX_MAX_RUNS, maxRunsRequested));

    const schedule: Schedule = {
      id: genId(),
      sessionKey: spec.sessionKey,
      cwd: spec.cwd,
      claudeSessionId: spec.claudeSessionId,
      prompt: spec.prompt,
      label: spec.label,
      kind: spec.kind,
      intervalMs: spec.intervalMs,
      cronExpr: spec.cronExpr,
      maxRuns,
      runs: 0,
      consecutiveFailures: 0,
      disabled: false,
      createdAt: new Date().toISOString(),
    };
    this.schedules.set(schedule.id, schedule);
    this.persist();
    this.arm(schedule);
    return schedule;
  }

  listSchedules(sessionKey: string): Schedule[] {
    return Array.from(this.schedules.values()).filter((s) => s.sessionKey === sessionKey);
  }

  getSchedule(id: string): Schedule | undefined {
    return this.schedules.get(id);
  }

  deleteSchedule(id: string): boolean {
    const existed = this.schedules.delete(id);
    this.disarm(id);
    if (existed) this.persist();
    return existed;
  }

  /** Next fire instant as an ISO string, for display. Undefined when the
   * schedule is disabled or its timer hasn't been armed (boot race). */
  nextFireAt(id: string): string | undefined {
    const schedule = this.schedules.get(id);
    if (!schedule || schedule.disabled) return undefined;
    if (schedule.kind === 'cron') {
      const job = this.cronJobs.get(id);
      const next = job?.nextRun();
      return next ? next.toISOString() : undefined;
    }
    if (schedule.lastFiredAt && schedule.intervalMs) {
      return new Date(new Date(schedule.lastFiredAt).getTime() + schedule.intervalMs).toISOString();
    }
    return undefined;
  }

  private armAll(): void {
    for (const id of this.intervalTimers.keys()) this.disarm(id);
    for (const id of this.cronJobs.keys()) this.disarm(id);
    for (const schedule of this.schedules.values()) this.arm(schedule);
  }

  private arm(schedule: Schedule): void {
    if (schedule.disabled) return;
    if (schedule.runs >= schedule.maxRuns) return;

    if (schedule.kind === 'interval' && schedule.intervalMs) {
      const timer = setInterval(() => this.fire(schedule.id), schedule.intervalMs);
      timer.unref();
      this.intervalTimers.set(schedule.id, timer);
    } else if (schedule.kind === 'cron' && schedule.cronExpr) {
      try {
        const job = new Cron(schedule.cronExpr, () => this.fire(schedule.id));
        this.cronJobs.set(schedule.id, job);
      } catch (err) {
        console.error(`[Scheduler] failed to arm cron ${schedule.id}:`, err);
      }
    }
  }

  private disarm(id: string): void {
    const timer = this.intervalTimers.get(id);
    if (timer) {
      clearInterval(timer);
      this.intervalTimers.delete(id);
    }
    const job = this.cronJobs.get(id);
    if (job) {
      try { job.stop(); } catch { /* ignore */ }
      this.cronJobs.delete(id);
    }
  }

  /** Internal: invoked by the timer/cron when a schedule should fire.
   * Delegates execution to the registered handler, then records the outcome. */
  private async fire(id: string): Promise<void> {
    const schedule = this.schedules.get(id);
    if (!schedule || schedule.disabled) return;
    if (!this.fireHandler) {
      console.warn(`[Scheduler] no fire handler registered, dropping fire for ${id}`);
      return;
    }
    if (schedule.runs >= schedule.maxRuns) {
      this.disarm(id);
      return;
    }

    let success = false;
    try {
      await this.fireHandler(schedule);
      success = true;
    } catch (err) {
      console.error(`[Scheduler] fire handler threw for ${id}:`, err);
    }
    this.recordFire(id, success);
  }

  /** Public so the runner can mark a fire complete after async work even if
   * it bypassed the internal `fire()` (e.g. coalesced/manual triggers). */
  recordFire(id: string, success: boolean): void {
    const schedule = this.schedules.get(id);
    if (!schedule) return;
    schedule.runs += 1;
    schedule.lastFiredAt = new Date().toISOString();
    schedule.consecutiveFailures = success ? 0 : schedule.consecutiveFailures + 1;

    if (schedule.runs >= schedule.maxRuns) {
      schedule.disabled = true;
      this.disarm(id);
    } else if (schedule.consecutiveFailures >= HARD_LIMITS.MAX_CONSECUTIVE_FAILURES) {
      schedule.disabled = true;
      this.disarm(id);
    }
    this.persist();
  }

  private persist(): void {
    ensureStateDir(HISTORY_DIR, 'Scheduler');
    writeJsonFile(getFile(), { schedules: Array.from(this.schedules.values()) }, 'Scheduler');
  }
}

export const scheduler = new Scheduler();
