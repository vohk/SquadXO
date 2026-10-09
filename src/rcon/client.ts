import { EventEmitter } from 'node:events';
import { Socket } from 'node:net';
import type { EOSID } from '../domain/identity.js';
import { RCON_PACKET, RconPacketDecoder, RconProtocolError, encodePacket } from './codec.js';
import type { RconPacket } from './codec.js';
import {
  parseCurrentLayer,
  parseNextLayer,
  parsePlayerList,
  parsePartyList,
  parseServerInfo,
  parseSquadList,
  type LayerInformation,
  type RconPlayer,
  type RconParty,
  type RconSquad
} from './squad-protocol.js';

export type RconConnectionState =
  'disconnected' | 'connecting' | 'authenticating' | 'ready' | 'stopping';

export interface RconClientOptions {
  readonly host: string;
  readonly port: number;
  readonly password: string;
  readonly connectTimeoutMs?: number;
  readonly authenticationTimeoutMs?: number;
  readonly commandTimeoutMs?: number;
  readonly reconnectMinimumDelayMs?: number;
  readonly reconnectMaximumDelayMs?: number;
  readonly reconnectJitter?: number;
  readonly maximumPacketSize?: number;
  readonly maximumBufferSize?: number;
  readonly autoReconnect?: boolean;
  readonly random?: () => number;
  readonly commandAllowed?: (command: string) => boolean;
}

export interface RconConnectionLostEvent {
  readonly error: Error;
  readonly disconnectedAt: Date;
  readonly willReconnect: boolean;
}

export interface RconReconnectedEvent {
  readonly disconnectedAt: Date;
  readonly reconnectedAt: Date;
  readonly durationMs: number;
  readonly attempts: number;
}

interface PendingCommand {
  readonly command: string;
  readonly resolve: (response: string) => void;
  readonly reject: (error: Error) => void;
  readonly count: number;
  readonly chunks: string[];
  timer?: NodeJS.Timeout;
}

interface ConnectionWaiter {
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

export class RconClient extends EventEmitter {
  readonly #options: Required<
    Omit<RconClientOptions, 'maximumPacketSize' | 'maximumBufferSize' | 'random' | 'commandAllowed'>
  > & {
    readonly maximumPacketSize: number;
    readonly maximumBufferSize: number;
    readonly random: () => number;
    readonly commandAllowed: (command: string) => boolean;
  };
  readonly #decoder: RconPacketDecoder;
  #socket: Socket | undefined;
  #state: RconConnectionState = 'disconnected';
  readonly #connectionWaiters: ConnectionWaiter[] = [];
  #connectTimer: NodeJS.Timeout | undefined;
  #authenticationTimer: NodeJS.Timeout | undefined;
  #reconnectTimer: NodeJS.Timeout | undefined;
  #reconnectAttempt = 0;
  #shouldReconnect = false;
  #outageStartedAt: Date | undefined;
  #lastSocketError: Error | undefined;
  #authenticationCount = 0;
  #nextCount = 1;
  #activeCommand: PendingCommand | undefined;
  readonly #queue: PendingCommand[] = [];

  constructor(options: RconClientOptions) {
    super();
    if (!options.host) throw new TypeError('RCON host is required');
    if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
      throw new TypeError('RCON port must be an integer between 1 and 65535');
    }
    if (!options.password) throw new TypeError('RCON password is required');

    this.#options = {
      host: options.host,
      port: options.port,
      password: options.password,
      connectTimeoutMs: options.connectTimeoutMs ?? 10_000,
      authenticationTimeoutMs: options.authenticationTimeoutMs ?? 10_000,
      commandTimeoutMs: options.commandTimeoutMs ?? 30_000,
      reconnectMinimumDelayMs: options.reconnectMinimumDelayMs ?? 500,
      reconnectMaximumDelayMs: options.reconnectMaximumDelayMs ?? 30_000,
      reconnectJitter: options.reconnectJitter ?? 0.2,
      maximumPacketSize: options.maximumPacketSize ?? 8192,
      maximumBufferSize: options.maximumBufferSize ?? 64 * 1024,
      autoReconnect: options.autoReconnect ?? true,
      random: options.random ?? Math.random,
      commandAllowed: options.commandAllowed ?? (() => true)
    };
    this.#decoder = new RconPacketDecoder({
      maximumPacketSize: this.#options.maximumPacketSize,
      maximumBufferSize: this.#options.maximumBufferSize
    });
  }

  get state(): RconConnectionState {
    return this.#state;
  }

  get queueDepth(): number {
    return this.#queue.length + (this.#activeCommand ? 1 : 0);
  }

  async connect(): Promise<void> {
    if (this.#state === 'ready') return;
    if (this.#state === 'stopping') throw new Error('RCON client is stopping');

    this.#shouldReconnect = this.#options.autoReconnect;
    this.#clearReconnectTimer();
    return new Promise<void>((resolve, reject) => {
      this.#connectionWaiters.push({ resolve, reject });
      if (this.#state === 'disconnected') this.#openSocket();
    });
  }

  execute(command: string): Promise<string> {
    if (this.#state !== 'ready') return Promise.reject(new Error('RCON client is not ready'));
    if (!command.trim()) return Promise.reject(new TypeError('RCON command cannot be empty'));
    if (!this.#options.commandAllowed(command)) {
      return Promise.reject(
        new Error(`RCON command blocked by runtime policy: ${commandName(command)}`)
      );
    }

    return new Promise<string>((resolve, reject) => {
      this.#queue.push({ command, resolve, reject, count: this.#allocateCount(), chunks: [] });
      this.#startNextCommand();
    });
  }

  async stop(): Promise<void> {
    this.#shouldReconnect = false;
    this.#clearReconnectTimer();
    this.#outageStartedAt = undefined;
    this.#reconnectAttempt = 0;
    this.#lastSocketError = undefined;
    this.#setState('stopping');
    this.#rejectConnection(new Error('RCON client stopped'));
    this.#rejectCommands(new Error('RCON client stopped'));
    this.#clearDeadlines();
    this.#decoder.reset();

    const socket = this.#socket;
    this.#socket = undefined;
    if (socket && !socket.destroyed) {
      await new Promise<void>((resolve) => {
        socket.once('close', () => resolve());
        socket.destroy();
      });
    }
    this.#setState('disconnected');
  }

  disconnect(): Promise<void> {
    return this.stop();
  }

  #openSocket(): void {
    this.#clearDeadlines();
    this.#decoder.reset();
    this.#lastSocketError = undefined;
    this.#setState('connecting');
    const socket = new Socket();
    this.#socket = socket;
    socket.on('data', (chunk: Buffer) => this.#onData(chunk));
    socket.on('error', (error: Error) => {
      if (socket === this.#socket) this.#lastSocketError = error;
      this.emit('socketError', error);
    });
    socket.on('close', () => this.#onClose(socket));
    socket.once('connect', () => this.#onConnect(socket));
    this.#connectTimer = setTimeout(
      () => this.#failConnection(new Error('RCON connection timed out')),
      this.#options.connectTimeoutMs
    );
    socket.connect(this.#options.port, this.#options.host);
  }

  #onConnect(socket: Socket): void {
    if (socket !== this.#socket || this.#state !== 'connecting') return;
    this.#clearTimer('connect');
    this.#setState('authenticating');
    // Squad's implementation expects the first command to reuse the authentication sequence.
    this.#authenticationCount = this.#nextCount;
    socket.write(
      encodePacket(
        RCON_PACKET.auth,
        RCON_PACKET.end,
        this.#authenticationCount,
        this.#options.password,
        this.#options.maximumPacketSize
      )
    );
    this.#authenticationTimer = setTimeout(
      () => this.#failConnection(new Error('RCON authentication timed out')),
      this.#options.authenticationTimeoutMs
    );
  }

  #onData(chunk: Buffer): void {
    try {
      for (const packet of this.#decoder.push(chunk)) this.#onPacket(packet);
    } catch (error) {
      this.#failConnection(
        error instanceof RconProtocolError ? error : new RconProtocolError(String(error))
      );
    }
  }

  #onPacket(packet: RconPacket): void {
    this.emit('packet', packet);
    if (packet.type === RCON_PACKET.chat) {
      this.emit('chat', packet);
      return;
    }

    if (this.#state === 'authenticating') {
      if (packet.count !== this.#authenticationCount) return;
      if (packet.type === RCON_PACKET.response) return;
      if (packet.type !== RCON_PACKET.authResponse) {
        this.#failConnection(new RconProtocolError('Unexpected packet while authenticating'));
        return;
      }
      if (packet.id === 0xff || packet.count === 0xffff) {
        this.#failConnection(new Error('RCON authentication failed'));
        return;
      }
      this.#clearTimer('authentication');
      const outageStartedAt = this.#outageStartedAt;
      const reconnectedAt = outageStartedAt ? new Date() : undefined;
      const reconnectAttempts = this.#reconnectAttempt;
      this.#outageStartedAt = undefined;
      this.#reconnectAttempt = 0;
      this.#setState('ready');
      this.#resolveConnections();
      this.emit('ready');
      if (outageStartedAt && reconnectedAt) {
        this.emit('reconnected', {
          disconnectedAt: outageStartedAt,
          reconnectedAt,
          durationMs: reconnectedAt.getTime() - outageStartedAt.getTime(),
          attempts: reconnectAttempts
        } satisfies RconReconnectedEvent);
      }
      this.#startNextCommand();
      return;
    }

    if (this.#state !== 'ready' || packet.type !== RCON_PACKET.response) return;
    const active = this.#activeCommand;
    if (!active || packet.count !== active.count) {
      this.emit('unmatchedPacket', packet);
      return;
    }
    if (packet.id === RCON_PACKET.mid) {
      active.chunks.push(packet.body);
      return;
    }
    if (packet.id !== RCON_PACKET.end) {
      this.#failConnection(new RconProtocolError(`Unexpected response packet id: ${packet.id}`));
      return;
    }

    if (packet.body) active.chunks.push(packet.body);
    if (active.timer) clearTimeout(active.timer);
    this.#activeCommand = undefined;
    active.resolve(active.chunks.join(''));
    this.#startNextCommand();
  }

  #startNextCommand(): void {
    if (this.#state !== 'ready' || this.#activeCommand) return;
    const next = this.#queue.shift();
    if (!next) return;
    const socket = this.#socket;
    if (!socket?.writable) {
      next.reject(new Error('RCON socket is not writable'));
      this.#failConnection(new Error('RCON socket is not writable'));
      return;
    }

    this.#activeCommand = next;
    this.emit('commandSent', { command: commandName(next.command), count: next.count });
    next.timer = setTimeout(
      () => this.#failConnection(new Error(`RCON command timed out: ${commandName(next.command)}`)),
      this.#options.commandTimeoutMs
    );
    const commandPacket = encodePacket(
      RCON_PACKET.command,
      RCON_PACKET.mid,
      next.count,
      next.command,
      this.#options.maximumPacketSize
    );
    const endPacket = encodePacket(
      RCON_PACKET.command,
      RCON_PACKET.end,
      next.count,
      '',
      this.#options.maximumPacketSize
    );
    socket.write(commandPacket);
    socket.write(endPacket);
  }

  #onClose(socket: Socket): void {
    if (socket !== this.#socket) return;
    const previousState = this.#state;
    this.#socket = undefined;
    this.#clearDeadlines();
    this.#decoder.reset();
    const wasStopping = previousState === 'stopping';
    this.#setState('disconnected');
    const error = this.#lastSocketError ?? new Error('RCON connection closed');
    this.#lastSocketError = undefined;
    this.#rejectConnection(error);
    this.#rejectCommands(error);
    if (!wasStopping && previousState === 'ready') this.#beginOutage(error);
    if (!wasStopping) this.#scheduleReconnect();
  }

  #failConnection(error: Error): void {
    if (this.#state === 'disconnected' || this.#state === 'stopping') return;
    const previousState = this.#state;
    this.emit('connectionError', error);
    this.#rejectConnection(error);
    this.#rejectCommands(error);
    this.#clearDeadlines();
    this.#setState('disconnected');
    if (previousState === 'ready') this.#beginOutage(error);
    const socket = this.#socket;
    if (socket && !socket.destroyed) socket.destroy();
    else this.#scheduleReconnect();
  }

  #scheduleReconnect(): void {
    if (!this.#shouldReconnect || this.#reconnectTimer || this.#state === 'stopping') return;
    const baseDelay = Math.min(
      this.#options.reconnectMaximumDelayMs,
      this.#options.reconnectMinimumDelayMs * 2 ** this.#reconnectAttempt
    );
    this.#reconnectAttempt += 1;
    const jitter = baseDelay * this.#options.reconnectJitter;
    const delay = Math.max(0, baseDelay - jitter + this.#options.random() * jitter * 2);
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      if (this.#state !== 'disconnected') return;
      this.#openSocket();
    }, delay);
  }

  #beginOutage(error: Error): void {
    if (this.#outageStartedAt) return;
    this.#outageStartedAt = new Date();
    this.emit('connectionLost', {
      error,
      disconnectedAt: this.#outageStartedAt,
      willReconnect: this.#shouldReconnect
    } satisfies RconConnectionLostEvent);
  }

  #rejectConnection(error: Error): void {
    while (this.#connectionWaiters.length > 0) {
      this.#connectionWaiters.shift()?.reject(error);
    }
  }

  #resolveConnections(): void {
    while (this.#connectionWaiters.length > 0) {
      this.#connectionWaiters.shift()?.resolve();
    }
  }

  #rejectCommands(error: Error): void {
    const active = this.#activeCommand;
    this.#activeCommand = undefined;
    if (active?.timer) clearTimeout(active.timer);
    active?.reject(error);
    while (this.#queue.length > 0) this.#queue.shift()?.reject(error);
  }

  #clearDeadlines(): void {
    this.#clearTimer('connect');
    this.#clearTimer('authentication');
  }

  #clearTimer(timer: 'connect' | 'authentication'): void {
    const current = timer === 'connect' ? this.#connectTimer : this.#authenticationTimer;
    if (current) clearTimeout(current);
    if (timer === 'connect') this.#connectTimer = undefined;
    else this.#authenticationTimer = undefined;
  }

  #clearReconnectTimer(): void {
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = undefined;
  }

  #setState(state: RconConnectionState): void {
    if (state === this.#state) return;
    this.#state = state;
    this.emit('state', state);
  }

  #allocateCount(): number {
    const count = this.#nextCount;
    this.#nextCount = this.#nextCount >= 65_534 ? 1 : this.#nextCount + 1;
    return count;
  }
}

export class SquadRconClient extends RconClient {
  async listPlayers(): Promise<RconPlayer[]> {
    return parsePlayerList(await this.execute('ListPlayers'));
  }

  async listSquads(): Promise<RconSquad[]> {
    return parseSquadList(await this.execute('ListSquads'));
  }

  async listParties(): Promise<RconParty[]> {
    return parsePartyList(await this.execute('ListParties'));
  }

  async showCurrentMap(): Promise<LayerInformation> {
    return parseCurrentLayer(await this.execute('ShowCurrentMap'));
  }

  async showNextMap(): Promise<LayerInformation> {
    return parseNextLayer(await this.execute('ShowNextMap'));
  }

  async showServerInfo(): Promise<Readonly<Record<string, unknown>>> {
    return parseServerInfo(await this.execute('ShowServerInfo'));
  }

  async broadcast(message: string): Promise<void> {
    await this.execute(`AdminBroadcast ${message}`);
  }

  async warn(eosID: EOSID, message: string): Promise<void> {
    await this.execute(`AdminWarn "${eosID}" ${message}`);
  }

  async kick(eosID: EOSID, reason: string): Promise<void> {
    await this.execute(`AdminKick "${eosID}" ${reason}`);
  }

  async ban(eosID: EOSID, interval: string, reason: string): Promise<void> {
    await this.execute(`AdminBan "${eosID}" ${interval} ${reason}`);
  }

  async forceTeamChange(eosID: EOSID): Promise<void> {
    await this.execute(`AdminForceTeamChange "${eosID}"`);
  }
}

function commandName(command: string): string {
  return command.trim().split(/\s+/, 1)[0] ?? 'unknown';
}
