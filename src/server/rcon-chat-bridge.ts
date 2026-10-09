import type { LegacyServerHost } from '../compatibility/legacy-server-facade.js';
import type { EOSID } from '../domain/identity.js';
import type { LivePlayer, ServerState } from '../domain/server-state.js';
import type { SquadRconClient } from '../rcon/client.js';
import type { RconPacket } from '../rcon/codec.js';
import { parseRconBroadcast, type RconBroadcastEvent } from '../rcon/squad-protocol.js';

export interface RconChatBridgeOptions {
  readonly refreshPlayers?: () => Promise<void>;
  readonly onMalformedMessage?: () => void;
  readonly onError?: (error: Error) => void;
}

export function startRconChatBridge(
  rcon: SquadRconClient,
  state: ServerState,
  events: LegacyServerHost,
  options: RconChatBridgeOptions = {}
): () => void {
  const adminCameraEntries = new Map<string, Date>();
  let stopped = false;
  const listener = (packet: RconPacket): void => {
    const event = parseRconBroadcast(packet.body);
    if (!event) {
      options.onMalformedMessage?.();
      return;
    }
    const player = resolvePlayer(event);
    if (event.name !== 'SQUAD_CREATED' && player) {
      publish(event, player);
      return;
    }
    if (event.name === 'SQUAD_CREATED' && player && !options.refreshPlayers) {
      const squadID = typeof event.data.squadID === 'number' ? event.data.squadID : undefined;
      if (squadID === undefined) {
        options.onError?.(new Error('SQUAD_CREATED is missing a numeric squad ID'));
        return;
      }
      publish(event, state.upsertPlayer({ ...player, squadID }));
      return;
    }
    void publishResolved(event).catch((error: unknown) => {
      if (!stopped) {
        options.onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    });
  };

  const resolvePlayer = (event: RconBroadcastEvent): LivePlayer | undefined => {
    const data = event.data;
    const eosID = typeof data.eosID === 'string' ? data.eosID : undefined;
    const name =
      typeof data.name === 'string'
        ? data.name
        : typeof data.playerName === 'string'
          ? data.playerName
          : undefined;
    return (
      (eosID ? state.getPlayerByEOSID(eosID as EOSID) : undefined) ??
      (name ? state.getPlayerByName(name) : undefined)
    );
  };

  const publishResolved = async (event: RconBroadcastEvent): Promise<void> => {
    const data = event.data;
    const eosID = typeof data.eosID === 'string' ? data.eosID : undefined;
    let player = resolvePlayer(event);
    if (event.name === 'SQUAD_CREATED' || !player) {
      await options.refreshPlayers?.();
      player = resolvePlayer(event);
    }
    if (stopped) return;
    if (event.name === 'SQUAD_CREATED' && (!player || player.teamID === undefined)) {
      throw new Error(
        `Could not resolve authoritative player state for SQUAD_CREATED (${eosID ?? 'missing EOS ID'})`
      );
    }
    if (event.name === 'SQUAD_CREATED') {
      const squadID = typeof data.squadID === 'number' ? data.squadID : undefined;
      if (squadID === undefined) throw new Error('SQUAD_CREATED is missing a numeric squad ID');
      player = state.upsertPlayer({ ...player!, squadID });
    }
    publish(event, player);
  };

  const publish = (event: RconBroadcastEvent, resolvedPlayer?: LivePlayer): void => {
    const data = event.data;
    const eosID = typeof data.eosID === 'string' ? data.eosID : undefined;
    const name =
      typeof data.name === 'string'
        ? data.name
        : typeof data.playerName === 'string'
          ? data.playerName
          : undefined;
    let player = resolvedPlayer ?? (eosID ? state.getPlayerByEOSID(eosID as EOSID) : undefined);
    player ??= name ? state.getPlayerByName(name) : undefined;

    if (event.name === 'SQUAD_CREATED' && player && typeof data.squadID === 'number') {
      player = state.upsertPlayer({ ...player, squadID: data.squadID });
    }

    if (event.name === 'POSSESSED_ADMIN_CAMERA' && eosID && data.time instanceof Date) {
      adminCameraEntries.set(eosID, data.time);
    }

    let duration: number | undefined;
    if (event.name === 'UNPOSSESSED_ADMIN_CAMERA' && eosID && data.time instanceof Date) {
      const enteredAt = adminCameraEntries.get(eosID);
      duration = enteredAt ? data.time.getTime() - enteredAt.getTime() : 0;
      adminCameraEntries.delete(eosID);
    }

    events.publish({
      name: event.name,
      data: {
        ...data,
        ...(duration === undefined ? {} : { duration }),
        ...(player ? { player } : {})
      }
    });
  };
  const onConnectionError = (error: Error): void => {
    events.publish({ name: 'RCON_ERROR', data: { error, time: new Date() } });
  };
  rcon.on('chat', listener);
  rcon.on('connectionError', onConnectionError);
  return () => {
    stopped = true;
    rcon.off('chat', listener);
    rcon.off('connectionError', onConnectionError);
    adminCameraEntries.clear();
  };
}
