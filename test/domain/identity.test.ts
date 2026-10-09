import assert from 'node:assert/strict';
import test from 'node:test';
import { asEOSID, asSteamID } from '../../src/domain/identity.js';

test('normalizes a valid EOS ID', () => {
  assert.equal(asEOSID('ABCDEF0123456789ABCDEF0123456789'), 'abcdef0123456789abcdef0123456789');
});

test('rejects malformed durable identities', () => {
  assert.throws(() => asEOSID('not-an-eos-id'), /32 hexadecimal/);
  assert.throws(() => asSteamID('1234'), /17 decimal/);
});
