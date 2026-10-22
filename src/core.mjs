/**
 * The checks that keep the wallet safe, with no I/O, so the shared test vectors cover them exactly.
 * (The Python MCP has the same functions; both run the same vectors.)
 *
 *   verifyEnvelope   every engine message is signed by onestop's engine key: Ed25519 over SHA-256 of
 *                    canonical JSON of {type, body}
 *   *Params          what this MCP asked for, as the engine must have committed to it
 *   guard            the pre-sign check run on every transaction before the wallet signs it
 */
import { createHash } from 'node:crypto';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import {
  decompileTransactionMessage, getBase64Encoder, getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder, getTransactionDecoder, partiallySignTransaction,
} from '@solana/kit';

export const WSOL = 'So11111111111111111111111111111111111111112';
const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const TOKEN_PROGRAMS = ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'];
export const MAX_PRIORITY_FEE = 5_000_000n;  // lamports, 0.005 SOL
export const SOL_TOLERANCE = 10_000n;        // lamports of rounding the wallet may lose beyond the quote
const SYSTEM_FORBIDDEN = [1, 8, 9, 10];      // Assign, Allocate, AllocateWithSeed, AssignWithSeed
const TOKEN_FORBIDDEN = [4, 6, 13];          // Approve, SetAuthority, ApproveChecked
const TOKEN_CLOSE = 9;

// ---------------------------------------------------------------- messages

export function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v)]));
  if (typeof value === 'number' && !Number.isInteger(value) && Number.isFinite(value) && Math.abs(value) < 1e-4) {
    return value.toFixed(18).replace(/0+$/, '').replace(/\.$/, '') || '0';
  }
  return value;
}

const sortKeys = (v) => Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v;

/** Keys sorted, no spaces, anything past ASCII written as \uXXXX: byte for byte what the engine signs. */
export function canonical(value) {
  return JSON.stringify(sortKeys(normalize(value)))
    .replace(/[^\x00-\x7F]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

const sha256 = (text) => createHash('sha256').update(text).digest();
export const commitment = (params) => sha256(canonical(params)).toString('hex');

export function verifyEnvelope(envelope, engineKey) {
  try {
    const digest = sha256(canonical({ type: envelope.type, body: envelope.body }));
    return nacl.sign.detached.verify(digest, bs58.decode(envelope.sig), bs58.decode(engineKey));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- commitments

export class CommitmentError extends Error {}

function trigger(asked, placed, entryMcap) {
  const out = { type: asked.type };
  if (asked.type === 'limit' || asked.type === 'limit_trailing') {
    if (asked.target_mcap_usd != null) {
      const usd = Number(asked.target_mcap_usd);
      const bps = Number(placed.target_bps);
      if (Math.abs((entryMcap * bps) / 10_000 - usd) > entryMcap / 10_000) {  // more than one bps of rounding
        throw new CommitmentError(`the engine set the level to ${bps} bps of $${entryMcap}, not $${usd}`);
      }
      out.target_bps = bps;
    } else {
      out.target_bps = Number(asked.target_bps);
    }
  }
  if (asked.type === 'trailing' || asked.type === 'limit_trailing') out.trail_bps = Number(asked.trail_bps);
  return out;
}

const twap = (asked) => asked ? { slices: Number(asked.slices), interval_s: Number(asked.interval_s) } : null;
const optInt = (v) => v == null ? null : Number(v);

export function orderParams(asked, placed) {
  const p = {
    mint: asked.mint, side: asked.side, trigger: trigger(asked.trigger, placed.trigger, placed.entry_mcap),
    twap: twap(asked.twap), slippage_bps: optInt(asked.slippage_bps), paper: Boolean(asked.paper ?? false),
  };
  if (asked.amount != null) p.amount = BigInt(asked.amount).toString();
  else p.holdings_bps = Number(asked.holdings_bps);
  return p;
}

export function planParams(asked, placed) {
  const e = asked.entry;  // a stage counts when it's given, even empty ({} exits at once), as the engine reads it
  const entry = e != null ? {
    amount: BigInt(e.amount).toString(), trigger: trigger(e.trigger, placed.entry.trigger, placed.entry_order.entry_mcap),
    twap: twap(e.twap),
  } : null;
  const protect = asked.protect;
  const exit = asked.exit;
  return {
    mint: asked.mint, entry,
    protect: protect != null ? { arm_bps: Number(protect.arm_bps), trail_bps: Number(protect.trail_bps) } : null,
    exit: exit != null ? { target_bps: optInt(exit.target_bps), twap: twap(exit.twap), sell_bps: Number(exit.sell_bps ?? 10_000) } : null,
    amount: asked.amount != null ? BigInt(asked.amount).toString() : null,
    holdings_bps: optInt(asked.holdings_bps), slippage_bps: optInt(asked.slippage_bps), paper: Boolean(asked.paper ?? false),
  };
}

/** What a plan's exit must be. The amount is the engine's; check it against what was bought separately. */
export function exitParams(plan, placedExit) {
  const exit = plan.exit ?? {};
  let trig = { type: 'now' };
  if (plan.protect != null) trig = { type: 'limit_trailing', target_bps: Number(plan.protect.arm_bps), trail_bps: Number(plan.protect.trail_bps) };
  else if (exit.target_bps) trig = { type: 'limit', target_bps: Number(exit.target_bps) };
  const p = { mint: plan.mint, side: 'sell', trigger: trig, twap: twap(exit.twap), slippage_bps: optInt(plan.slippage_bps),
    paper: Boolean(plan.paper ?? false) };
  if (placedExit.amount != null) p.amount = BigInt(placedExit.amount).toString();
  else p.holdings_bps = Number(placedExit.holdings_bps);
  return p;
}

/** The most a plan's exit may sell: a share of what the entry bought, or of what was held. */
export function exitAllowance(plan, tokensBought) {
  const sellBps = BigInt((plan.exit ?? {}).sell_bps ?? 10_000);
  if (tokensBought != null) return { amount: (BigInt(tokensBought) * sellBps) / 10_000n };
  if (plan.amount != null) return { amount: (BigInt(plan.amount) * sellBps) / 10_000n };
  const share = (BigInt(plan.holdings_bps) * sellBps) / 10_000n;
  return { holdings_bps: share > 0n ? share : 1n };
}

/** An order view's commitment input, to compare with what it should be. */
export function viewParams(o) {
  const p = { mint: o.mint, side: o.side, trigger: o.trigger, twap: o.twap, slippage_bps: o.slippage_bps, paper: o.paper };
  if (o.amount != null) p.amount = String(o.amount);
  else p.holdings_bps = o.holdings_bps;
  return p;
}

// ---------------------------------------------------------------- the pre-sign guard

const txDecoder = getTransactionDecoder();
const messageDecoder = getCompiledTransactionMessageDecoder();
const base64 = getBase64Encoder();

export function decodeTransaction(txBase64) {
  const tx = txDecoder.decode(base64.encode(txBase64));
  const compiled = messageDecoder.decode(tx.messageBytes);
  return { tx, compiled, message: decompileTransactionMessage(compiled) };
}

function tokenChanges(sim, wallet) {
  const changes = new Map();
  for (const [sign, entries] of [[-1n, sim.preTokenBalances], [1n, sim.postTokenBalances]]) {
    for (const e of entries ?? []) {
      if (e.owner === wallet) changes.set(e.mint, (changes.get(e.mint) ?? 0n) + sign * BigInt(e.uiTokenAmount.amount));
    }
  }
  return changes;
}

/**
 * Reasons not to sign; empty means the transaction may be signed. `sim` is this exact transaction
 * simulated on the wallet's own RPC, never the engine's word.
 */
export function guard(txBase64, quote, sim, wallet, gasWallet) {
  let decoded;
  try {
    decoded = decodeTransaction(txBase64);
  } catch {
    return ['not_v1'];
  }
  const { compiled, message } = decoded;
  if (message.version !== 1) return ['not_v1'];
  const codes = new Set();
  const keys = compiled.staticAccounts;
  if (keys[0] !== gasWallet) codes.add('fee_payer');
  if (compiled.header.numSignerAccounts !== 2 || keys[1] !== wallet) codes.add('signers');
  const cfg = message.config ?? {};
  if (!cfg.computeUnitLimit || !cfg.loadedAccountsDataSizeLimit) codes.add('resource_limits');
  if (BigInt(cfg.priorityFeeLamports ?? 0) > MAX_PRIORITY_FEE) codes.add('priority_fee');
  const pre = sim.preBalances ?? [];
  for (const ix of message.instructions) {
    const accounts = (ix.accounts ?? []).map((a) => a.address);
    const data = ix.data ?? new Uint8Array();
    if (ix.programAddress === SYSTEM_PROGRAM && data.length >= 4
        && SYSTEM_FORBIDDEN.includes(new DataView(data.buffer, data.byteOffset).getUint32(0, true)) && accounts.includes(wallet)) {
      codes.add('forbidden_instruction');
    }
    if (TOKEN_PROGRAMS.includes(ix.programAddress) && data.length) {
      if (TOKEN_FORBIDDEN.includes(data[0]) && accounts.includes(wallet)) codes.add('forbidden_instruction');
      if (data[0] === TOKEN_CLOSE && accounts.length >= 3 && accounts[2] === wallet && accounts[1] !== wallet) {
        const i = keys.indexOf(accounts[0]);  // only an account this transaction opened may close to someone else
        if (i < 0 || i >= pre.length || pre[i] !== 0) codes.add('close_not_new');
      }
    }
  }
  if (!keys.includes(wallet)) return [...codes, 'signers'].filter((c, i, a) => a.indexOf(c) === i).sort();
  if (sim.err) return [...codes, 'simulation_failed'].sort();

  const i = keys.indexOf(wallet);
  const post = sim.postBalances ?? [];
  if (i >= pre.length || i >= post.length) return [...codes, 'simulation_failed'].sort();
  const solChange = BigInt(post[i]) - BigInt(pre[i]);
  const amountIn = BigInt(quote.amount_in);
  const gas = BigInt(quote.gas.lamports);
  const minOut = BigInt(quote.min_out);
  const solIn = quote.input_mint === WSOL ? amountIn : 0n;
  if (solChange < -(solIn + gas + SOL_TOLERANCE)) codes.add('sol_loss');
  const tokens = tokenChanges(sim, wallet);
  for (const [mint, change] of tokens) {
    if (change < (mint === quote.input_mint ? -amountIn : 0n)) codes.add('token_loss');
  }
  if (quote.output_mint === WSOL) {
    if (solChange < minOut - gas - SOL_TOLERANCE) codes.add('output_short');
  } else if ((tokens.get(quote.output_mint) ?? 0n) < minOut) {
    codes.add('output_short');
  }
  return [...codes].sort();
}

/** Add the wallet's signature, leaving onestop's slot for the protect lane. */
export async function signAsWallet(txBase64, keyPair) {
  const { tx } = decodeTransaction(txBase64);
  return getBase64EncodedWireTransaction(await partiallySignTransaction([keyPair], tx));
}
