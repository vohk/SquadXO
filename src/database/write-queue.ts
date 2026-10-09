export class DatabaseWriteQueue {
  readonly #maximumPending: number;
  readonly #onError: (error: Error) => void;
  #tail: Promise<void> = Promise.resolve();
  #pending = 0;
  #highWaterMark = 0;
  #rejected = 0;

  constructor(
    options: { readonly maximumPending?: number; readonly onError?: (error: Error) => void } = {}
  ) {
    this.#maximumPending = options.maximumPending ?? 1000;
    this.#onError = options.onError ?? (() => undefined);
  }

  get pending(): number {
    return this.#pending;
  }

  get highWaterMark(): number {
    return this.#highWaterMark;
  }

  get rejected(): number {
    return this.#rejected;
  }

  enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#pending >= this.#maximumPending) {
      this.#rejected += 1;
      return Promise.reject(new Error(`DBLog write queue is full (${this.#maximumPending})`));
    }
    this.#pending += 1;
    this.#highWaterMark = Math.max(this.#highWaterMark, this.#pending);
    const result = this.#tail.then(operation);
    this.#tail = result.then(
      () => undefined,
      (error: unknown) => this.#onError(error instanceof Error ? error : new Error(String(error)))
    );
    return result.finally(() => {
      this.#pending -= 1;
    });
  }

  async drain(): Promise<void> {
    await this.#tail;
  }
}
