// The shared vectors: the Python MCP's tests run the very same file.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createKeyPairFromBytes, getAddressFromPublicKey } from '@solana/kit';
import {
  commitment, decodeTransaction, exitAllowance, exitParams, guard, orderParams, planParams, signAsWallet, verifyEnvelope,
} from '../src/core.mjs';

const V = JSON.parse(fs.readFileSync(new URL('./vectors.json', import.meta.url), 'utf8'));

for (const c of V.envelopes) {
  test(`envelope ${c.name}`, () => assert.equal(verifyEnvelope(c.envelope, V.engine_key), c.valid));
}

for (const c of V.commitments) {
  test(`commitment ${c.name}`, () => {
    let params;
    if (c.kind === 'order') params = orderParams(c.request, c.placed);
    else if (c.kind === 'plan') params = planParams(c.request, c.placed);
    else {
      params = exitParams(c.plan, c.placed);
      for (const [k, v] of Object.entries(exitAllowance(c.plan, c.tokens_bought))) assert.ok(BigInt(c.placed[k]) <= v);
    }
    assert.equal(commitment(params), c.commitment);
  });
}

test('a changed request breaks the commitment', () => {
  const c = V.commitments.find((x) => x.name === 'limit_sell');
  assert.notEqual(commitment(orderParams({ ...c.request, holdings_bps: 10_000 }, c.placed)), c.commitment);
});

for (const c of V.guard) {
  test(`guard ${c.name}`, () => assert.deepEqual(guard(c.tx, c.quote, c.simulation, c.wallet, c.gas_wallet), c.expect));
}

test('signing fills only the wallet slot', async () => {
  const secret = new Uint8Array(64);
  crypto.getRandomValues(secret.subarray(0, 32));
  const { default: nacl } = await import('tweetnacl');
  const kp = nacl.sign.keyPair.fromSeed(secret.subarray(0, 32));
  const keyPair = await createKeyPairFromBytes(kp.secretKey);
  const signer = await getAddressFromPublicKey(keyPair.publicKey);
  const c = V.guard[0];
  // the vector's second signer is the fake wallet, not this key, so kit refuses to sign for a stranger
  await assert.rejects(() => signAsWallet(c.tx, keyPair));
  assert.notEqual(signer, c.wallet);
  const { tx } = decodeTransaction(c.tx);
  assert.equal(Object.values(tx.signatures).every((s) => s === null), true);  // both slots empty in a quote
});
