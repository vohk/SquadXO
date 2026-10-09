import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { SquadLogParser, type ParserStatistics } from './parser.js';

export interface ReplayEvent {
  readonly name: string;
}

export interface ReplayRule {
  readonly name: string;
  match(line: string): ReplayEvent | undefined;
}

export interface ReplaySummary {
  readonly source: string;
  readonly totalLines: number;
  readonly matchedLines: number;
  readonly unmatchedLines: number;
  readonly eventCounts: Readonly<Record<string, number>>;
}

export async function replayLog(
  source: string,
  rules: readonly ReplayRule[] = []
): Promise<ReplaySummary> {
  const input = createReadStream(source, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  const eventCounts: Record<string, number> = {};
  let totalLines = 0;
  let matchedLines = 0;

  for await (const line of lines) {
    totalLines += 1;
    for (const rule of rules) {
      const event = rule.match(line);
      if (event === undefined) continue;
      matchedLines += 1;
      eventCounts[event.name] = (eventCounts[event.name] ?? 0) + 1;
      break;
    }
  }

  return {
    source,
    totalLines,
    matchedLines,
    unmatchedLines: totalLines - matchedLines,
    eventCounts
  };
}

export interface SquadReplaySummary extends ParserStatistics {
  readonly source: string;
  readonly firstEventTime?: Date;
  readonly lastEventTime?: Date;
}

export async function replaySquadLog(source: string): Promise<SquadReplaySummary> {
  const parser = new SquadLogParser();
  const input = createReadStream(source, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  let firstEventTime: Date | undefined;
  let lastEventTime: Date | undefined;

  for await (const line of lines) {
    for (const parsedEvent of parser.parseLine(line)) {
      const time = parsedEvent.data.time;
      if (!(time instanceof Date) || Number.isNaN(time.getTime())) continue;
      firstEventTime ??= time;
      lastEventTime = time;
    }
  }

  return {
    source,
    ...parser.statistics(),
    ...(firstEventTime ? { firstEventTime } : {}),
    ...(lastEventTime ? { lastEventTime } : {})
  };
}
