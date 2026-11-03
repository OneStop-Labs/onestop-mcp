/**
 * The MCP's side of onestop: REST for quotes and swaps, the WebSocket for orders and plans, and the
 * wallet's signature on every fill.
 *
 * The wallet signs only what this MCP can vouch for. Every engine message must carry onestop's engine
 * signature. A fill is signed only for an order this MCP placed (its commitment checked) or an exit the
 * engine created for one of this MCP's plans (checked against the plan, selling no more than the entry
 * bought). Every transaction is simulated on the wallet's own RPC and must pass the guard. With
 * ONESTOP_DRY_RUN nothing is ever sent.
 *
 * What it knows (orders, plans, tokens each entry bought) is kept in a small state file, so a restart
 * (which happens whenever the agent's client restarts) loses nothing.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import bs58 from 'bs58';
import WebSocket from 'ws';
import { createKeyPairFromBytes, createKeyPairFromPrivateKeyBytes, getAddressFromPublicKey, signBytes } from '@solana/kit';
import {
  CommitmentError, WSOL, commitment, exitAllowance, exitParams, guard, orderParams, planParams, signAsWallet,
  verifyEnvelope, viewParams,
} from './core.mjs';

export const ALIASES = { SOL: WSOL, USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB' };
// The trust anchor: onestop's engine signing key, built in and never fetched.
export const SERVER_PUBKEY = 'A4TyC2862KZWtEXZxe9WDtA9wf45edryTHXH32ozinfx';
export const API_URL = 'https://api.onestop.trade';
const SPEND_CHECKS = ['sol_loss', 'token_loss', 'output_short'];  // what ONESTOP_SKIP_SPEND_CHECK turns off
const BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];
const RECENT_QUOTES = 20;

export class OnestopError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.code = code;
    this.detail = message;
  }
}

const home = (p) => p.replace(/^~/, os.homedir());
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref());

async function within(promise, ms, code, message) {
  let timer;
  const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new OnestopError(code, message)), ms); });
  try {
    return await Promise.race([promise, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** POST the body, or GET without one. */
async function fetchJson(url, body, ms) {
  const post = body && { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
  const r = await fetch(url, { ...post, signal: AbortSignal.timeout(ms) });
  return { r, data: await r.json().catch(() => ({})) };
}

const flag = (v) => ['1', 'true', 'yes'].includes((v ?? '').trim().toLowerCase());

/** A wallet's key as wallets export it: base58 or a keypair file's JSON, 64 bytes or the 32-byte private key alone. */
async function walletKey(raw) {
  let bytes;
  try {
    bytes = raw.startsWith('[') ? Uint8Array.from(JSON.parse(raw)) : bs58.decode(raw);
  } catch {
    bytes = null;
  }
  if (bytes?.length === 64) return createKeyPairFromBytes(bytes);
  if (bytes?.length === 32) return createKeyPairFromPrivateKeyBytes(bytes);
  throw new OnestopError('bad_wallet', "the wallet key isn't a Solana private key: paste it as your wallet exports it (base58), or a keypair file's [numbers]");
}

export async function configFromEnv(env = process.env) {
  let raw = (env.ONESTOP_PRIVATE_KEY ?? '').trim();
  const file = (env.ONESTOP_KEYPAIR_PATH ?? '').trim();
  if (file) raw = fs.readFileSync(home(file), 'utf8').trim();
  if (!raw) throw new OnestopError('no_wallet', 'set ONESTOP_KEYPAIR_PATH (a keypair file) or ONESTOP_PRIVATE_KEY');
  const keyPair = await walletKey(raw);
  const wallet = await getAddressFromPublicKey(keyPair.publicKey);
  const serverKeys = [env.ONESTOP_SERVER_PUBKEY || SERVER_PUBKEY, env.ONESTOP_SERVER_PUBKEY_NEXT]  // the second is for rotation
    .map((k) => (k ?? '').trim()).filter(Boolean);
  if (!serverKeys.length) throw new OnestopError('no_server_key', "this build has no onestop server key; set ONESTOP_SERVER_PUBKEY");
  const apiUrl = (env.ONESTOP_API_URL || API_URL).trim().replace(/\/$/, '');
  if (!apiUrl) throw new OnestopError('no_api_url', "this build has no onestop API URL; set ONESTOP_API_URL");
  return {
    keyPair, wallet, serverKeys, apiUrl,
    rpcUrl: (env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com').trim(),
    dryRun: flag(env.ONESTOP_DRY_RUN),
    skipSpendCheck: flag(env.ONESTOP_SKIP_SPEND_CHECK),
    statePath: home(env.ONESTOP_STATE || `~/.onestop-mcp/${wallet}.json`),
  };
}

export class Onestop {
  constructor(cfg) {
    this.cfg = cfg;
    this.wallet = cfg.wallet;
    this.activity = [];
    this.connected = false;
    this.socket = null;
    this.pending = new Map();
    this.quotes = new Map();  // recent quotes by transaction, for submitSwap
    this.n = 0;
    this.running = false;
    this.closed = false;
    this.waitForLogin();
    this.state = { orders: {}, plans: {}, pending_exits: {} };  // what this MCP placed or verified
    if (cfg.statePath && fs.existsSync(cfg.statePath)) Object.assign(this.state, JSON.parse(fs.readFileSync(cfg.statePath, 'utf8')));
  }

  // ---------------------------------------------------------------- lifecycle

  start() {
    if (!this.running) {
      this.running = true;
      this.run();
    }
  }

  close() {
    this.closed = true;
    this.ws?.close();
  }

  save() {
    if (!this.cfg.statePath) return;
    fs.mkdirSync(path.dirname(this.cfg.statePath), { recursive: true });
    fs.writeFileSync(this.cfg.statePath, JSON.stringify(this.state));
  }

  note(kind, fields = {}) {
    this.activity.unshift({ at: Math.floor(Date.now() / 1000), kind, ...fields });
    this.activity.length = Math.min(this.activity.length, 100);
  }

  waitForLogin() {
    this.ready = new Promise((resolve) => { this.markReady = resolve; });
  }

  /** Wait for the engine login (the MCP logs in by itself); whether it's connected. */
  async connect(ms = 20_000) {
    this.start();
    await within(this.ready, ms, 'engine_unreachable', "can't reach the onestop engine").catch(() => {});
    return this.connected;
  }

  signed(msg) {
    return this.cfg.serverKeys.some((key) => verifyEnvelope({ type: msg.type, body: msg.body, sig: msg.sig }, key));
  }

  // ---------------------------------------------------------------- the WebSocket

  async run() {
    let attempt = 0;
    while (!this.closed) {
      try {
        await this.session(() => { attempt = 0; });
      } catch (e) {  // reconnect; fills that fired meanwhile are delivered on login
        this.note('disconnected', { error: String(e.message ?? e).slice(0, 200) });
      }
      if (this.connected) this.waitForLogin();
      this.connected = false;
      this.socket = null;
      for (const p of this.pending.values()) p.reject(new OnestopError('disconnected', 'the connection to the engine dropped'));
      this.pending.clear();
      if (!this.closed) await sleep(BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]);
      attempt += 1;
    }
  }

  /** One connection: the signed challenge, the wallet's login, then engine messages until it drops. */
  session(onLogin) {
    return new Promise((resolve, reject) => {
      const socket = this.ws = new WebSocket(this.cfg.apiUrl.replace(/^http/, 'ws') + '/v1/ws', { maxPayload: 4 << 20 });
      const fail = (code, message) => {
        reject(new OnestopError(code, message));
        socket.terminate();
      };
      socket.on('message', async (raw) => {
        try {
          const msg = JSON.parse(String(raw));
          if (this.socket === socket) return this.onMessage(msg);
          if (!this.signed(msg)) return fail('bad_engine_signature', "the engine's challenge isn't signed by its key");
          if (msg.type === 'challenge') {
            const signature = await signBytes(this.cfg.keyPair.privateKey, new TextEncoder().encode(`onestop login ${msg.body.nonce}`));
            return socket.send(JSON.stringify({ action: 'login', wallet: this.wallet, signature: bs58.encode(signature) }));
          }
          if (msg.type !== 'logged_in') return fail('login_failed', JSON.stringify(msg.body));
          this.gasWallet = msg.body.gas_wallet;  // onestop's fee payer, signed by the engine's key above
          this.socket = socket;
          this.connected = true;
          onLogin();
          this.markReady();
        } catch (e) {
          this.note('error', { error: String(e.message ?? e).slice(0, 200) });
        }
      });
      socket.on('close', () => resolve());
      socket.on('error', reject);
    });
  }

  async request(action, fields = {}) {
    if (!(await this.connect()) || !this.socket) throw new OnestopError('engine_unreachable', "can't reach the onestop engine");
    const rid = `r${++this.n}`;
    const reply = new Promise((resolve, reject) => this.pending.set(rid, { resolve, reject }));
    this.socket.send(JSON.stringify({ action, request_id: rid, ...fields }));
    let msg;
    try {
      msg = await within(reply, 60_000, 'timeout', 'the engine took too long to answer');
    } finally {
      this.pending.delete(rid);
    }
    if (msg.type === 'error') throw new OnestopError(msg.body.code, msg.body.message);
    return msg.body;
  }

  onMessage(msg) {
    if (!this.signed(msg)) {
      return this.note('refused', { reason: "a message without onestop's engine signature" });
    }
    const waiting = this.pending.get(msg.request_id);
    if (waiting) return waiting.resolve(msg);
    const body = msg.body;
    if (msg.type === 'fill') this.onFill(body).catch((e) => this.note('error', { order_id: body.order_id, error: String(e.message ?? e) }));
    else if (msg.type === 'order_placed') this.adoptExit(body);
    else if (msg.type === 'order_update' || msg.type === 'plan_update') {
      const item = body.order ?? body.plan ?? {};
      this.note(msg.type, { id: item.order_id ?? item.plan_id, status: item.status, error: item.error });
    }
  }

  // ---------------------------------------------------------------- fills

  async onFill(body) {
    const oid = body.order_id;
    const known = this.state.orders[oid];
    if (body.paper) {
      this.note('paper_fill', { order_id: oid, slice: body.slice, amount_in: body.amount_in, expected_out: body.expected_out });
      return this.tally(known, BigInt(body.expected_out));
    }
    if (!known) return this.note('refused', { order_id: oid, reason: "a fill for an order this MCP didn't place" });
    const q = body.quote;
    const mismatch = this.crossCheck(known.params, q);
    if (mismatch) return this.note('refused', { order_id: oid, reason: mismatch });
    const result = await this.guardSignSubmit(q, oid);
    this.note('fill', { order_id: oid, slice: body.slice, slices: body.slices, status: result.status, signature: result.signature,
      reasons: result.reasons });
    if (result.status === 'confirmed' && result.fill) this.tally(known, BigInt(result.fill.output.change));
  }

  crossCheck(params, q) {
    const [input, output] = params.side === 'buy' ? [WSOL, params.mint] : [params.mint, WSOL];
    if (q.wallet !== this.wallet || q.input_mint !== input || q.output_mint !== output) {
      return "the fill doesn't match the order's wallet, token or side";
    }
    if (params.amount != null && BigInt(q.amount_in) > BigInt(params.amount)) return 'the fill spends more than the order';
    return null;
  }

  /** Tokens a plan's entry bought, counted from what this wallet actually received. */
  tally(known, received) {
    if (known?.stage !== 'entry') return;
    const plan = this.state.plans[known.plan_id];
    plan.tokens = (BigInt(plan.tokens) + received).toString();
    this.save();
    const waiting = this.state.pending_exits[known.plan_id];
    if (waiting) {  // the exit arrived before the entry's tokens were counted
      delete this.state.pending_exits[known.plan_id];
      this.adoptExit(waiting);
    }
  }

  async simulate(txBase64) {
    const { data } = await fetchJson(this.cfg.rpcUrl, { jsonrpc: '2.0', id: 1, method: 'simulateTransaction', params: [
      txBase64, { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'processed' }] }, 30_000);
    if (!data.result) throw new OnestopError('rpc_unavailable', "the wallet's RPC couldn't simulate the transaction");
    return data.result.value;
  }

  async guardSignSubmit(quote, orderId = null) {
    if (!this.gasWallet && !(await this.connect())) throw new OnestopError('engine_unreachable', "can't reach the onestop engine");
    const tx = quote.transaction.base64;
    let reasons = guard(tx, quote, await this.simulate(tx), this.wallet, this.gasWallet);
    if (this.cfg.skipSpendCheck) reasons = reasons.filter((r) => !SPEND_CHECKS.includes(r));
    if (reasons.length) return { status: 'refused', reasons };
    if (this.cfg.dryRun) return { status: 'dry_run', message: 'the guard passed; ONESTOP_DRY_RUN stopped it before sending' };
    return this.rest('/v1/protect', { transaction: await signAsWallet(tx, this.cfg.keyPair), order_id: orderId, wait: true });
  }

  // ---------------------------------------------------------------- orders and plans

  async placeOrder(order) {
    const body = await this.request('place_order', { order });
    const placed = body.order;
    let params;
    try {
      params = orderParams(order, placed);
    } catch (e) {
      if (!(e instanceof CommitmentError)) throw e;
      await this.request('cancel_order', { order_id: placed.order_id });
      throw new OnestopError('bad_commitment', e.message);
    }
    if (commitment(params) !== body.commitment) {
      await this.request('cancel_order', { order_id: placed.order_id });
      throw new OnestopError('bad_commitment', "the engine's order isn't the one asked for; it was cancelled");
    }
    this.state.orders[placed.order_id] = { params };
    this.save();
    return placed;
  }

  async placePlan(plan) {
    const body = await this.request('place_plan', { plan });
    const placed = body.plan;
    let ok;
    try {
      ok = commitment(planParams(plan, placed)) === body.commitment;
    } catch (e) {
      if (!(e instanceof CommitmentError)) throw e;
      ok = false;
    }
    if (!ok) {
      await this.request('cancel_plan', { plan_id: placed.plan_id });
      throw new OnestopError('bad_commitment', "the engine's plan isn't the one asked for; it was cancelled");
    }
    const pid = placed.plan_id;
    this.state.plans[pid] = { asked: plan, tokens: '0' };
    if (placed.entry_order) {
      const asked = { ...plan.entry, mint: plan.mint, side: 'buy', slippage_bps: plan.slippage_bps, paper: plan.paper ?? false };
      this.state.orders[placed.entry_order.order_id] = { params: orderParams(asked, placed.entry_order), plan_id: pid, stage: 'entry' };
    }
    if (placed.exit_order) this.adoptExit({ order: placed.exit_order, commitment: null });  // tokens already held
    this.save();
    return placed;
  }

  adoptExit(body) {
    const o = body.order;
    const plan = this.state.plans[o.plan_id];
    if (!plan) return this.note('refused', { order_id: o.order_id, reason: "an order this MCP didn't ask for" });
    const params = exitParams(plan.asked, o);
    const expected = commitment(params);
    if ((body.commitment != null && expected !== body.commitment) || commitment(viewParams(o)) !== expected) {
      return this.note('refused', { order_id: o.order_id, reason: "the plan's exit doesn't match the plan; its fills won't be signed" });
    }
    const allowed = exitAllowance(plan.asked, plan.asked.entry ? plan.tokens : null);
    if (!Object.entries(allowed).every(([k, v]) => o[k] == null || BigInt(o[k]) <= v)) {
      // More than this wallet has seen the entry buy. The engine reports the exit as the entry settles,
      // which can be before the protect lane's answer reaches here: wait for the count, never sign beyond it.
      this.state.pending_exits[o.plan_id] = body;
      this.save();
      return this.note('exit_waiting', { order_id: o.order_id, plan_id: o.plan_id, amount: o.amount });
    }
    this.state.orders[o.order_id] = { params, plan_id: o.plan_id, stage: 'exit' };
    this.save();
    this.note('exit_adopted', { order_id: o.order_id, plan_id: o.plan_id, amount: o.amount });
  }

  // ---------------------------------------------------------------- REST

  async quote({ input, output, amount, holdings_bps: holdingsBps, slippage_bps: slippageBps }) {
    const body = { wallet: this.wallet, input_mint: ALIASES[input.toUpperCase()] ?? input,
      output_mint: ALIASES[output.toUpperCase()] ?? output, amount, holdings_bps: holdingsBps, slippage_bps: slippageBps };
    const q = await this.rest('/v1/trades', Object.fromEntries(Object.entries(body).filter(([, v]) => v != null)));
    this.quotes.set(q.transaction.base64, q);
    if (this.quotes.size > RECENT_QUOTES) this.quotes.delete(this.quotes.keys().next().value);
    return q;
  }

  /** Trade a transaction from quote(): the guard needs its quote, and onestop co-signs only what it quoted. */
  submitSwap(transaction) {
    const q = this.quotes.get(transaction);
    if (!q) throw new OnestopError('unknown_transaction', "only a transaction from this MCP's quote tool can be submitted");
    return this.guardSignSubmit(q);
  }

  async rest(route, body) {
    const { r, data } = await fetchJson(this.cfg.apiUrl + route, body, 150_000);
    if (r.status >= 400) throw new OnestopError(data.error?.code ?? 'engine_error', data.error?.message ?? r.statusText);
    return data;
  }
}

/** An order tool's flat arguments as the engine's order: {mint, side, amount | holdings_bps, trigger, twap?, ...}. */
export function orderBody(type, args) {
  const pick = (keys) => Object.fromEntries(keys.filter((k) => args[k] != null).map((k) => [k, args[k]]));
  const body = { ...pick(['mint', 'side', 'amount', 'holdings_bps', 'slippage_bps', 'expires_h', 'paper']),
    trigger: { type, ...pick(['target_bps', 'target_mcap_usd', 'trail_bps']) } };
  if (args.twap_slices != null || args.twap_interval_s != null) body.twap = { slices: args.twap_slices, interval_s: args.twap_interval_s };
  return body;
}
