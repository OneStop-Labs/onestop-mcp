// The MCP against the real engine running on the fake chain (engine/tests/fake_engine.py).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Onestop, configFromEnv } from '../src/client.mjs';
import { canonical } from '../src/core.mjs';

const ENGINE = fileURLToPath(new URL('../../engine/', import.meta.url));
// The engine is a separate repo: these tests run when it's checked out next to this one, with its .venv.
const NO_ENGINE = !fs.existsSync(path.join(ENGINE, '.venv/bin/python')) && "the onestop engine isn't checked out next to this repo";
const it = (name, opts, fn) => (fn ? test(name, { ...opts, skip: NO_ENGINE || opts.skip }, fn) : test(name, { skip: NO_ENGINE }, opts));
const OPEN = ['waiting', 'armed', 'filling'];
let session;
let engine;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'onestop-mcp-'));

async function until(check, ms = 15_000) {
  for (let waited = 0; waited < ms; waited += 100) {
    const result = await check();
    if (result) return result;
    await sleep(100);
  }
  throw new Error('timed out');
}

before(async () => {
  if (NO_ENGINE) return;
  const file = path.join(tmp(), 'session.json');
  engine = spawn(path.join(ENGINE, '.venv/bin/python'), [path.join(ENGINE, 'tests/fake_engine.py'), '--session', file],
    { env: { PYTHONDONTWRITEBYTECODE: '1', PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'ignore', 'inherit'] });
  session = await until(() => fs.existsSync(file) && JSON.parse(fs.readFileSync(file, 'utf8')), 10_000);
});
after(() => engine?.kill());

function env(dir, extra = {}) {
  const key = path.join(dir, 'wallet.json');
  fs.writeFileSync(key, JSON.stringify(session.wallet_key));
  return { ONESTOP_KEYPAIR_PATH: key, ONESTOP_SERVER_PUBKEY: session.engine_key, ONESTOP_API_URL: session.url,
    SOLANA_RPC_URL: `${session.url}/rpc`, ONESTOP_STATE: path.join(dir, 'state.json'), ...extra };
}

const make = async (dir, extra) => new Onestop(await configFromEnv(env(dir, extra)));
const setMcap = (mcap) => fetch(`${session.url}/test/mcap`, { method: 'POST', body: JSON.stringify({ mcap }),
  headers: { 'content-type': 'application/json' } });
const kinds = (c, kind) => c.activity.filter((a) => a.kind === kind);
const sellNow = () => ({ mint: session.mint, side: 'sell', amount: '10000000000', trigger: { type: 'now' } });
const sellLimit = () => ({ mint: session.mint, side: 'sell', holdings_bps: 100, trigger: { type: 'limit', target_bps: 50_000 } });

async function planDone(c, planId) {
  const { plan } = await c.request('get_plan', { plan_id: planId });
  return plan.status !== 'running' && plan;
}

it('a fill is guarded, signed and lands', async () => {
  await setMcap(1_000_000);
  const c = await make(tmp());
  const placed = await c.placeOrder(sellNow());
  const [done] = await until(() => kinds(c, 'fill').filter((a) => a.order_id === placed.order_id).length && kinds(c, 'fill'));
  assert.equal(done.status, 'confirmed');
  assert.ok(done.signature);
  assert.equal((await c.request('get_order', { order_id: placed.order_id })).order.status, 'filled');
  c.close();
});

it('dry run guards but never sends', async () => {
  await setMcap(1_000_000);
  const c = await make(tmp(), { ONESTOP_DRY_RUN: '1' });
  const placed = await c.placeOrder(sellNow());
  const [done] = await until(() => kinds(c, 'fill').length && kinds(c, 'fill'));
  assert.equal(done.status, 'dry_run');
  assert.equal((await c.request('get_order', { order_id: placed.order_id })).order.status, 'filling');
  await c.request('cancel_order', { order_id: placed.order_id });
  c.close();
});

it('a paper plan runs to the end', async () => {
  await setMcap(1_000_000);
  const c = await make(tmp());
  const placed = await c.placePlan({ mint: session.mint, paper: true, entry: { amount: '50000000', trigger: { type: 'now' } },
    protect: { arm_bps: 20_000, trail_bps: 1_000 } });
  await until(() => kinds(c, 'exit_adopted').length);
  for (const mcap of [2_100_000, 1_800_000]) {
    await setMcap(mcap);
    await sleep(600);
  }
  const plan = await until(() => planDone(c, placed.plan_id));
  assert.equal(plan.status, 'done');
  assert.ok(kinds(c, 'paper_fill').length >= 2);
  c.close();
});

it('a real plan signs its entry and its exit', async () => {
  await setMcap(1_000_000);
  const c = await make(tmp());
  const placed = await c.placePlan({ mint: session.mint, entry: { amount: '50000000', trigger: { type: 'now' } },
    exit: { target_bps: 15_000 } });
  await until(() => kinds(c, 'exit_adopted').length);
  assert.ok(BigInt(c.state.plans[placed.plan_id].tokens) > 0n);  // counted from what the wallet received
  await setMcap(1_600_000);
  const plan = await until(() => planDone(c, placed.plan_id));
  assert.equal(plan.status, 'done');
  assert.equal(kinds(c, 'fill').filter((a) => a.status === 'confirmed').length, 2);
  c.close();
});

it("the guard refuses what the simulation doesn't back", async () => {
  const c = await make(tmp());
  const q = await c.quote({ input: 'SOL', output: session.mint, amount: '50000000' });
  q.min_out = String(BigInt(q.expected_out) * 10n);  // a quote promising more than the transaction delivers
  assert.deepEqual(await c.guardSignSubmit(q), { status: 'refused', reasons: ['output_short'] });
  c.close();
  const lax = await make(tmp(), { ONESTOP_SKIP_SPEND_CHECK: '1', ONESTOP_DRY_RUN: '1' });
  const q2 = await lax.quote({ input: 'SOL', output: session.mint, amount: '50000000' });
  q2.min_out = String(BigInt(q2.expected_out) * 10n);
  assert.equal((await lax.guardSignSubmit(q2)).status, 'dry_run');  // the spend check is off, the rest still runs
  lax.close();
});

it("a fill this MCP didn't order is refused", async () => {
  await setMcap(1_000_000);
  const c = await make(tmp());
  const { order } = await c.request('place_order', { order: sellNow() });  // around the MCP's own records
  const [refused] = await until(() => kinds(c, 'refused').filter((a) => a.order_id === order.order_id).length && kinds(c, 'refused'));
  assert.match(refused.reason, /didn't place/);
  await c.request('cancel_order', { order_id: order.order_id });
  c.close();
});

it("a commitment that doesn't match cancels the order", async () => {
  await setMcap(1_000_000);
  const c = await make(tmp());
  const request = c.request.bind(c);
  c.request = async (action, fields) => {  // an engine that commits to something other than what it was asked
    const body = await request(action, fields);
    return action === 'place_order' ? { ...body, commitment: '00'.repeat(32) } : body;
  };
  await assert.rejects(() => c.placeOrder(sellLimit()), { code: 'bad_commitment' });
  const { orders } = await c.request('list_orders');
  assert.deepEqual(orders.filter((o) => OPEN.includes(o.status)), []);  // the MCP cancelled it
  c.close();
});

it('a forged engine message is ignored', async () => {
  const c = await make(tmp());
  const forger = nacl.sign.keyPair();
  const body = { order_id: 'x', slice: 1, slices: 1, quote: {} };
  const digest = createHash('sha256').update(canonical({ type: 'fill', body })).digest();
  c.onMessage({ type: 'fill', body, sig: bs58.encode(nacl.sign.detached(digest, forger.secretKey)) });
  assert.match(kinds(c, 'refused')[0].reason, /^a message without onestop's/);
  c.close();
});

it('what the MCP knows survives a restart', async () => {
  await setMcap(1_000_000);
  const dir = tmp();
  const c = await make(dir);
  const placed = await c.placeOrder(sellLimit());
  c.close();
  const again = await make(dir);
  assert.ok(again.state.orders[placed.order_id]);
  await again.request('cancel_order', { order_id: placed.order_id });
  again.close();
});

const SERVERS = {
  node: [process.execPath, [fileURLToPath(new URL('../src/index.mjs', import.meta.url))]],
  python: [fileURLToPath(new URL('../../mcp-python/.venv/bin/onestop-mcp', import.meta.url)), []],
};

async function serve(kind, extra, run) {
  const [command, args] = SERVERS[kind];
  const mcp = new Client({ name: 'test', version: '0' });
  await mcp.connect(new StdioClientTransport({ command, args, env: env(tmp(), extra), stderr: 'inherit' }));
  const call = async (name, a = {}) => JSON.parse((await mcp.callTool({ name, arguments: a })).content[0].text);
  try {
    return await run(mcp, call);
  } finally {
    await mcp.close();
  }
}

it("the server's tools work end to end", async () => {
  await setMcap(1_000_000);
  await serve('node', {}, async (mcp, call) => {
    assert.equal((await mcp.listTools()).tools.length, 19);
    assert.equal((await call('connect')).connected, true);
    const q = await call('quote', { input: 'SOL', output: session.mint, amount: '50000000' });
    const done = await call('submit_swap', { transaction: q.transaction.base64 });
    assert.equal(done.status, 'confirmed');
    assert.ok(done.signature);
    assert.equal((await call('submit_swap', { transaction: 'AAAA' })).error.code, 'unknown_transaction');
    const placed = await call('limit_order', { mint: session.mint, side: 'sell', holdings_bps: 100, target_bps: 50_000 });
    assert.deepEqual(placed.trigger, { type: 'limit', target_bps: 50_000 });
    assert.equal((await call('get_order', { order_id: placed.order_id })).order.status, 'waiting');
    await call('cancel_order', { order_id: placed.order_id });
    assert.equal((await call('get_order', { order_id: placed.order_id })).order.status, 'cancelled');
    assert.equal((await call('wallet')).orders_known, 1);
    assert.ok((await call('get_order', { order_id: 'nope' })).error.code);
  });
});

it('dry run places nothing, but paper still runs', async () => {
  await setMcap(1_000_000);
  await serve('node', { ONESTOP_DRY_RUN: '1' }, async (mcp, call) => {
    const held = await call('trailing_order', { mint: session.mint, side: 'sell', holdings_bps: 100, trail_bps: 1_000 });
    assert.equal(held.status, 'dry_run');
    assert.equal(held.request.trail_bps, 1_000);
    const paper = await call('twap_order', { mint: session.mint, side: 'buy', amount: '50000000', twap_slices: 2,
      twap_interval_s: 10, paper: true });
    assert.ok(paper.order_id && paper.paper);
    await call('cancel_order', { order_id: paper.order_id });
    assert.equal((await call('wallet')).orders_known, 1);  // only the paper order reached onestop
  });
});

const PARKED = !fs.existsSync(SERVERS.python[0]) && 'the Python MCP is parked and not installed here';
it('the Node and Python MCPs offer the same tools', { skip: PARKED }, async () => {
  const surface = (kind) => serve(kind, {}, async (mcp) => Object.fromEntries((await mcp.listTools()).tools.map((t) => [t.name, {
    description: t.description,
    required: [...(t.inputSchema.required ?? [])].sort(),
    args: Object.fromEntries(Object.entries(t.inputSchema.properties ?? {}).map(([k, v]) => [k, v.description ?? null])),
  }])));
  const [node, python] = await Promise.all([surface('node'), surface('python')]);
  assert.deepEqual(python, node);
});
