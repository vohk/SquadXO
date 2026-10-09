export interface ScheduledTaskHealth {
  readonly running: boolean;
  readonly runCount: number;
  readonly failureCount: number;
  readonly lastStartedAt?: Date;
  readonly lastSucceededAt?: Date;
  readonly lastError?: string;
}

interface ScheduledTask {
  readonly intervalMs: number;
  readonly operation: () => Promise<void>;
  timer?: NodeJS.Timeout;
  running: boolean;
  runCount: number;
  failureCount: number;
  lastStartedAt?: Date;
  lastSucceededAt?: Date;
  lastError?: string;
}

export class NonOverlappingScheduler {
  readonly #tasks = new Map<string, ScheduledTask>();
  #started = false;

  add(name: string, intervalMs: number, operation: () => Promise<void>): void {
    if (this.#tasks.has(name)) throw new Error(`Scheduled task already exists: ${name}`);
    if (!Number.isFinite(intervalMs) || intervalMs < 1)
      throw new TypeError('Interval must be positive');
    this.#tasks.set(name, {
      intervalMs,
      operation,
      running: false,
      runCount: 0,
      failureCount: 0
    });
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    for (const [name] of this.#tasks) void this.#run(name);
  }

  async stop(): Promise<void> {
    this.#started = false;
    for (const task of this.#tasks.values()) {
      if (task.timer) clearTimeout(task.timer);
      delete task.timer;
    }
    while ([...this.#tasks.values()].some((task) => task.running)) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }

  health(name: string): ScheduledTaskHealth | undefined {
    const task = this.#tasks.get(name);
    if (!task) return undefined;
    return {
      running: task.running,
      runCount: task.runCount,
      failureCount: task.failureCount,
      ...(task.lastStartedAt ? { lastStartedAt: task.lastStartedAt } : {}),
      ...(task.lastSucceededAt ? { lastSucceededAt: task.lastSucceededAt } : {}),
      ...(task.lastError ? { lastError: task.lastError } : {})
    };
  }

  async #run(name: string): Promise<void> {
    const task = this.#tasks.get(name);
    if (!task || !this.#started || task.running) return;
    task.running = true;
    task.runCount += 1;
    task.lastStartedAt = new Date();
    try {
      await task.operation();
      task.lastSucceededAt = new Date();
      delete task.lastError;
    } catch (error) {
      task.failureCount += 1;
      task.lastError = error instanceof Error ? error.message : String(error);
    } finally {
      task.running = false;
      if (this.#started) {
        task.timer = setTimeout(() => void this.#run(name), task.intervalMs);
      }
    }
  }
}
