import type { ServerInformationEvent } from '../domain/events.js';

export interface PlayerCountWriter {
  playerCount(
    time: Date,
    players: number,
    publicQueue: number,
    reserveQueue: number
  ): Promise<void>;
}

export async function samplePlayerCount(
  writer: PlayerCountWriter,
  information: Readonly<Record<string, unknown>>,
  time: Date = new Date()
): Promise<boolean> {
  if (!isServerInformation(information)) return false;
  await writer.playerCount(
    time,
    information.a2sPlayerCount,
    information.publicQueue,
    information.reserveQueue
  );
  return true;
}

function isServerInformation(
  information: Readonly<Record<string, unknown>>
): information is ServerInformationEvent {
  return (
    finite(information.a2sPlayerCount) &&
    finite(information.publicQueue) &&
    finite(information.reserveQueue)
  );
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
