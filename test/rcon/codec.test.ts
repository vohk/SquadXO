import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RCON_PACKET,
  RconPacketDecoder,
  RconProtocolError,
  encodePacket
} from '../../src/rcon/codec.js';

test('decodes fragmented and combined packets incrementally', () => {
  const first = encodePacket(RCON_PACKET.response, RCON_PACKET.mid, 7, 'first');
  const second = encodePacket(RCON_PACKET.response, RCON_PACKET.end, 7, 'second');
  const combined = Buffer.concat([first, second]);
  const decoder = new RconPacketDecoder();

  assert.deepEqual(decoder.push(combined.subarray(0, 5)), []);
  assert.deepEqual(decoder.push(combined.subarray(5, first.length - 1)), []);
  const packets = decoder.push(combined.subarray(first.length - 1));
  assert.deepEqual(
    packets.map(({ count, id, body }) => ({ count, id, body })),
    [
      { count: 7, id: RCON_PACKET.mid, body: 'first' },
      { count: 7, id: RCON_PACKET.end, body: 'second' }
    ]
  );
  assert.equal(decoder.bufferedBytes, 0);
});

test('consumes Squad broken follow-up packets, including across chunks', () => {
  const broken = Buffer.alloc(21);
  broken.writeUInt32LE(10, 0);
  broken.writeUInt8(RCON_PACKET.end, 4);
  broken.writeUInt16LE(42, 6);
  broken.writeUInt32LE(0, 8);
  Buffer.from([0, 0, 0, 1, 0, 0, 0]).copy(broken, 12);
  broken.writeUInt16LE(0, 19);
  const decoder = new RconPacketDecoder();

  assert.deepEqual(decoder.push(broken.subarray(0, 7)), []);
  assert.deepEqual(decoder.push(broken.subarray(7)), []);
  assert.equal(decoder.bufferedBytes, 0);
});

test('rejects impossible lengths and bounds retained input', () => {
  const invalid = Buffer.alloc(4);
  invalid.writeInt32LE(9, 0);
  const decoder = new RconPacketDecoder({ maximumBufferSize: 16 });
  assert.throws(() => decoder.push(invalid), RconProtocolError);
  assert.equal(decoder.bufferedBytes, 0);

  assert.throws(() => decoder.push(Buffer.alloc(17)), /buffer exceeded/);
  assert.equal(decoder.bufferedBytes, 0);
});
