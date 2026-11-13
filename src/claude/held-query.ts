import type { Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

/**
 * An SDK query kept running after its reply, for the background work it
 * started — see userMessage in agent.ts for why the CLI needs its input held
 * open for that.
 *
 * The reply is delivered when the turn ends; the query then belongs to no
 * turn. Its messages are still read, so a finished task's notification gets a
 * sub-turn whose reply is posted on its own. The chat's next message is pushed
 * into the same query's input rather than starting a second CLI on the same
 * session, which would be told the first one's tasks had ended and would
 * leave them to die with it.
 */

/**
 * The prompt stream of a query: messages pushed in, in order, until `end`.
 * The CLI treats the stream's end as the end of its input.
 */
export class PromptChannel {
  private queue: SDKUserMessage[] = [];
  private wake: (() => void) | undefined;
  private ended = false;

  constructor(first: SDKUserMessage) {
    this.queue.push(first);
  }

  get isOpen(): boolean {
    return !this.ended;
  }

  /** False once the stream has ended: the message would never be read. */
  push(message: SDKUserMessage): boolean {
    if (this.ended) return false;
    this.queue.push(message);
    this.wake?.();
    return true;
  }

  end(): void {
    this.ended = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      const next = this.queue.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.ended) return;
      await new Promise<void>((resolve) => { this.wake = resolve; });
      this.wake = undefined;
    }
  }
}

/** One reader's view of a QueryFeed. */
export interface FeedReader {
  messages: AsyncIterable<SDKMessage>;
  /** The feed moved on to the next reader rather than ending. */
  handedOver(): boolean;
}

interface Sink {
  buffer: SDKMessage[];
  wake: (() => void) | undefined;
  done: boolean;
  handedOver: boolean;
  error: unknown;
}

/**
 * A query's messages, read once and passed to one reader at a time.
 *
 * A turn that joins a held query waits as the next reader; it takes over at
 * the first message `takesOver` accepts (its own prompt starting), and the
 * reader before it — still answering a task notification, say — stops there.
 */
export class QueryFeed {
  private current: Sink | undefined;
  private next: { sink: Sink; takesOver: (m: SDKMessage) => boolean } | undefined;
  private started = false;
  private finished = false;
  private resolveClosed!: () => void;
  /** Settles once the query's stream has ended. */
  readonly closed = new Promise<void>((resolve) => { this.resolveClosed = resolve; });

  constructor(
    private readonly source: AsyncIterable<SDKMessage>,
    private readonly closeSource: () => void,
  ) {}

  attach(takesOver?: (m: SDKMessage) => boolean): FeedReader {
    const sink: Sink = { buffer: [], wake: undefined, done: false, handedOver: false, error: undefined };
    if (this.finished) {
      sink.done = true;
    } else if (!this.current) {
      this.current = sink;
    } else {
      if (this.next) this.finish(this.next.sink);
      this.next = { sink, takesOver: takesOver ?? (() => true) };
    }
    if (!this.started) {
      this.started = true;
      void this.pump();
    }
    return {
      messages: { [Symbol.asyncIterator]: () => this.read(sink) },
      handedOver: () => sink.handedOver,
    };
  }

  private async pump(): Promise<void> {
    let error: unknown;
    try {
      for await (const message of this.source) {
        if (this.next && this.next.takesOver(message)) this.handOver();
        if (this.current) this.deliver(this.current, message);
      }
    } catch (err) {
      error = err;
    }
    this.finished = true;
    if (this.current) {
      this.current.error = error;
      this.finish(this.current);
    }
    if (this.next) this.finish(this.next.sink);
    this.resolveClosed();
  }

  private handOver(): void {
    if (this.current) {
      this.current.handedOver = true;
      this.finish(this.current);
    }
    this.current = this.next?.sink;
    this.next = undefined;
  }

  private deliver(sink: Sink, message: SDKMessage): void {
    sink.buffer.push(message);
    sink.wake?.();
  }

  private finish(sink: Sink): void {
    sink.done = true;
    sink.wake?.();
  }

  private async *read(sink: Sink): AsyncGenerator<SDKMessage> {
    try {
      for (;;) {
        const message = sink.buffer.shift();
        if (message) {
          yield message;
          continue;
        }
        if (sink.done) {
          if (sink.error) throw sink.error;
          return;
        }
        await new Promise<void>((resolve) => { sink.wake = resolve; });
        sink.wake = undefined;
      }
    } finally {
      // A reader that stops early (an abort) leaves the query to the next
      // one if there is one, and otherwise closes it, as breaking out of the
      // SDK's own iterator does.
      if (!sink.done && this.current === sink) {
        if (this.next) this.handOver();
        else this.closeSource();
      }
      sink.done = true;
    }
  }
}

/** State a query's turns share, whichever of them is reading it. */
export interface QueryShared {
  /** Tasks started in this query and not yet reported on. */
  liveTasks: Set<string>;
  /** Between a result and the next turn, held only for liveTasks. */
  waitingOnTasks: boolean;
  /** The query's running total_cost_usd, so each turn reports its own part. */
  costSoFar: number;
}

export interface HeldQuery {
  query: Query;
  controller: AbortController;
  input: PromptChannel;
  feed: QueryFeed;
  shared: QueryShared;
  /** The Claude session the query is on. */
  sessionId: string | undefined;
  /** The model it was last asked to use, as TeleCoder names it. */
  model: string;
  permissionMode: string;
  /** Everything else a turn must agree on to join it — cwd, binary, effort… */
  fingerprint: string;
}

const heldQueries = new Map<string, HeldQuery>();

export function holdQuery(sessionKey: string, held: HeldQuery): void {
  heldQueries.set(sessionKey, held);
  void held.feed.closed.then(() => {
    if (heldQueries.get(sessionKey) === held) heldQueries.delete(sessionKey);
  });
}

/** The held query, no longer held: the caller joins it or lets it go. */
export function takeHeldQuery(sessionKey: string): HeldQuery | undefined {
  const held = heldQueries.get(sessionKey);
  heldQueries.delete(sessionKey);
  return held;
}

export function getHeldQuery(sessionKey: string): HeldQuery | undefined {
  return heldQueries.get(sessionKey);
}

/** Ends a held query's input; its tasks stop when the CLI exits. */
export function releaseHeldQuery(sessionKey: string): boolean {
  const held = heldQueries.get(sessionKey);
  if (!held || !held.input.isOpen) return false;
  held.input.end();
  return true;
}
