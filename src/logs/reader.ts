export interface LogReaderHealth {
  readonly running: boolean;
  readonly source: string;
  readonly offset: number;
  readonly lastLineAt?: Date;
  readonly pollingLatencyMs?: number;
  readonly replacements: number;
}

export type LogLineHandler = (line: string) => void | Promise<void>;

export interface LogSnapshotOptions {
  readonly maximumBytes: number;
  readonly signal?: AbortSignal;
}

export interface LogSnapshot {
  readonly sourceBytes: number;
  readonly modifiedAt?: Date;
}

export interface LogReader {
  start(handler: LogLineHandler): Promise<void>;
  stop(): Promise<void>;
  health(): LogReaderHealth;
  copySnapshot(destination: string, options: LogSnapshotOptions): Promise<LogSnapshot>;
}
