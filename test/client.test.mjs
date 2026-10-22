// The client's own bookkeeping, with no engine.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Onestop } from '../src/client.mjs';

const MINT = '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R';

test('an exit never sells more than the entry bought', () => {
  const c = new Onestop({ wallet: 'w', serverKeys: ['x'], apiUrl: 'http://127.0.0.1:1', statePath: null });
  const plan = { mint: MINT, entry: { amount: '50000000', trigger: { type: 'now' } }, exit: { target_bps: 15_000 } };
  c.state.plans.p = { asked: plan, tokens: '0' };
  const entry = c.state.orders.e = { params: {}, plan_id: 'p', stage: 'entry' };
  const exitOrder = { order_id: 'x', plan_id: 'p', mint: MINT, side: 'sell', amount: '1000', twap: null,
    trigger: { type: 'limit', target_bps: 15_000 }, slippage_bps: null, paper: false };

  c.adoptExit({ order: exitOrder, commitment: null });  // before the entry's tokens are counted
  assert.equal(c.activity[0].kind, 'exit_waiting');
  assert.equal(c.state.orders.x, undefined);
  c.tally(entry, 999n);
  assert.equal(c.activity[0].kind, 'exit_waiting');
  assert.equal(c.state.orders.x, undefined);
  c.tally(entry, 1n);
  assert.equal(c.activity[0].kind, 'exit_adopted');
  assert.equal(c.state.orders.x.stage, 'exit');

  c.adoptExit({ order: { ...exitOrder, order_id: 'y', trigger: { type: 'now' } }, commitment: null });
  assert.equal(c.activity[0].kind, 'refused');  // not the plan's exit
  assert.equal(c.state.orders.y, undefined);
});

test('the wallet key works as wallets export it', async () => {
  const { default: nacl } = await import('tweetnacl');
  const { default: bs58 } = await import('bs58');
  const { configFromEnv } = await import('../src/client.mjs');
  const kp = nacl.sign.keyPair();
  const address = bs58.encode(kp.publicKey);
  const wallet = async (key) => (await configFromEnv({ ONESTOP_PRIVATE_KEY: key })).wallet;
  assert.equal(await wallet(bs58.encode(kp.secretKey)), address);              // base58, as Phantom exports it
  assert.equal(await wallet(JSON.stringify([...kp.secretKey])), address);      // a keypair file's numbers
  assert.equal(await wallet(bs58.encode(kp.secretKey.slice(0, 32))), address); // the 32-byte private key alone
  await assert.rejects(() => wallet('not-a-key-0OIl'), { code: 'bad_wallet' });
  await assert.rejects(() => wallet(bs58.encode(kp.secretKey.slice(0, 20))), { code: 'bad_wallet' });
});
