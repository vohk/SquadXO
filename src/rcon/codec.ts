export const RCON_PACKET = {
  response: 0x00,
  chat: 0x01,
  command: 0x02,
  authResponse: 0x02,
  auth: 0x03,
  mid: 0x01,
  end: 0x02
} as const;

const HEADER_AND_TERMINATOR_SIZE = 14;
const MIN_DECLARED_SIZE = 10;
const BROKEN_FOLLOW_UP_SIZE = 21;
const BROKEN_FOLLOW_UP_BODY = Buffer.from([0, 0, 0, 1, 0, 0, 0]);

export interface RconPacket {
  readonly size: number;
  readonly id: number;
  readonly count: number;
  readonly type: number;
  readonly body: string;
}

export class RconProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RconProtocolError';
  }
}

export function encodePacket(
  type: number,
  id: number,
  count: number,
  body: string,
  maximumPacketSize = 4096
): Buffer {
  const packetSize = Buffer.byteLength(body, 'utf8') + HEADER_AND_TERMINATOR_SIZE;
  if (packetSize > maximumPacketSize) {
    throw new RconProtocolError(
      `RCON packet is ${packetSize} bytes; maximum is ${maximumPacketSize}`
    );
  }

  const packet = Buffer.alloc(packetSize);
  packet.writeUInt32LE(packetSize - 4, 0);
  packet.writeUInt8(id, 4);
  packet.writeUInt8(0, 5);
  packet.writeUInt16LE(count, 6);
  packet.writeUInt32LE(type, 8);
  packet.write(body, 12, packetSize - 2, 'utf8');
  packet.writeUInt16LE(0, packetSize - 2);
  return packet;
}

export function decodePacket(packet: Buffer): RconPacket {
  if (packet.length < HEADER_AND_TERMINATOR_SIZE) {
    throw new RconProtocolError(`RCON packet is too short: ${packet.length} bytes`);
  }

  const declaredSize = packet.readUInt32LE(0);
  if (declaredSize + 4 !== packet.length) {
    throw new RconProtocolError(
      `RCON packet length mismatch: declared ${declaredSize + 4}, received ${packet.length}`
    );
  }
  if (packet.readUInt16LE(packet.length - 2) !== 0) {
    throw new RconProtocolError('RCON packet is missing its null terminator');
  }

  return {
    size: declaredSize,
    id: packet.readUInt8(4),
    count: packet.readUInt16LE(6),
    type: packet.readUInt32LE(8),
    body: packet.toString('utf8', 12, packet.length - 2)
  };
}

export class RconPacketDecoder {
  readonly #maximumPacketSize: number;
  readonly #maximumBufferSize: number;
  #buffer = Buffer.alloc(0);

  constructor(options: { maximumPacketSize?: number; maximumBufferSize?: number } = {}) {
    this.#maximumPacketSize = options.maximumPacketSize ?? 8192;
    this.#maximumBufferSize = options.maximumBufferSize ?? 64 * 1024;
  }

  get bufferedBytes(): number {
    return this.#buffer.length;
  }

  reset(): void {
    this.#buffer = Buffer.alloc(0);
  }

  push(chunk: Buffer): RconPacket[] {
    if (chunk.length === 0) return [];
    if (this.#buffer.length + chunk.length > this.#maximumBufferSize) {
      this.reset();
      throw new RconProtocolError('RCON receive buffer exceeded its configured limit');
    }

    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    const packets: RconPacket[] = [];

    while (this.#buffer.length >= 4) {
      const declaredSize = this.#buffer.readInt32LE(0);
      if (declaredSize < MIN_DECLARED_SIZE) {
        this.reset();
        throw new RconProtocolError(`Invalid RCON packet size: ${declaredSize}`);
      }

      const packetSize = declaredSize + 4;
      if (packetSize > this.#maximumPacketSize) {
        this.reset();
        throw new RconProtocolError(`RCON packet exceeds maximum size: ${packetSize}`);
      }

      if (declaredSize === MIN_DECLARED_SIZE && this.#buffer.length >= BROKEN_FOLLOW_UP_SIZE) {
        if (
          this.#buffer.subarray(12, 19).equals(BROKEN_FOLLOW_UP_BODY) &&
          this.#buffer.readUInt16LE(19) === 0
        ) {
          this.#buffer = this.#buffer.subarray(BROKEN_FOLLOW_UP_SIZE);
          continue;
        }
      }

      if (this.#buffer.length < packetSize) break;
      const packet = this.#buffer.subarray(0, packetSize);
      this.#buffer = this.#buffer.subarray(packetSize);
      packets.push(decodePacket(packet));
    }

    return packets;
  }
}
