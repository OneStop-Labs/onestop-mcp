#!/usr/bin/env node
// The onestop MCP server: trading tools for an AI agent, with the wallet's key staying on this machine.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Onestop, OnestopError, configFromEnv, orderBody } from './client.mjs';

const SIGNING = 'Signing: fills are signed by this MCP process. If it isn\'t running when an order fires, the fill is '
  + 'queued and executed on reconnect at the then-current price.';
const UNITS = 'A buy takes amount in lamports; a sell takes amount in raw token units or holdings_bps of the balance when '
  + 'it fires. paper: true rehearses with real prices and never trades. It lapses after expires_h hours if it hasn\'t fired.';
const DRY_NOTE = 'ONESTOP_DRY_RUN is on, so nothing was placed. Paper orders and plans (paper: true) still run.';

let client = null;
let failure = null;
try {
  client = new Onestop(await configFromEnv());
  client.start();  // log in at once, so fills arrive while the agent is idle
} catch (e) {
  failure = e;  // reported by every tool call
}

const server = new McpServer({ name: 'onestop', version: '1.0.1' }, {
  instructions: 'Trade Solana tokens through onestop: gasless swaps (no SOL needed; a 1% fee plus the network cost, both '
    + 'taken from the trade), market-cap orders and plans that buy and then protect a position. Amounts are raw units '
    + '(lamports for SOL); levels are basis points. Call wallet first. ' + SIGNING,
});

/** Register a tool. `writes` tools place or keep orders, so dry run answers them without calling onestop. */
function tool(name, description, shape, run, writes = false) {
  server.registerTool(name, { description, inputSchema: shape }, async (args = {}) => {
    let result;
    try {
      if (failure) throw failure;
      result = writes && client.cfg.dryRun && !args.paper ? { status: 'dry_run', message: DRY_NOTE, request: args } : await run(args);
    } catch (e) {
      result = { error: e instanceof OnestopError ? { code: e.code, message: e.detail } : { code: 'error', message: String(e.message ?? e) } };
    }
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  });
}

// ---------------------------------------------------------------- arguments

const int = (min, max) => z.number().int().min(min).max(max);
const raw = z.string().regex(/^\d+$/, 'a whole number, as a string');
const hours = int(1, 720);
const A = {
  mint: z.string().describe("the token's mint address"),
  side: z.enum(['buy', 'sell']).describe('buy spends SOL on the token; sell sells the token for SOL'),
  amount: raw.optional().describe('a buy: the SOL to spend, in lamports (1 SOL = 1000000000). A sell: raw token units. Give this or holdings_bps'),
  holdings_bps: int(1, 10_000).optional().describe("a sell: the share of the wallet's balance when it fires, 10000 = all"),
  target_bps: int(1, 1_000_000).optional().describe('the level as a share of the market cap now: 20000 = 2x, 5000 = half'),
  target_mcap_usd: z.number().positive().optional().describe('or the level as a market cap in USD'),
  trail_bps: int(1, 9_900).describe('how far the market cap must move back from its best to fire: 1000 = 10%'),
  twap_slices: int(2, 100).describe('fill in this many slices instead of one swap'),
  twap_interval_s: int(10, 86_400).describe('seconds between slices'),
  slippage_bps: int(1, 5_000).optional().describe('the most the price may move against a fill, default 300 = 3%'),
  expires_h: hours.optional().describe("hours until it lapses if it hasn't fired, default 24"),
  paper: z.boolean().optional().describe('true: rehearse with real prices; fills are recorded, never signed or traded'),
  order_id: z.string().describe('the order_id the order was placed with'),
  plan_id: z.string().describe('the plan_id the plan was placed with'),
};
const order = { mint: A.mint, side: A.side, amount: A.amount, holdings_bps: A.holdings_bps };
const extras = { slippage_bps: A.slippage_bps, expires_h: A.expires_h, paper: A.paper };
const level = { target_bps: A.target_bps, target_mcap_usd: A.target_mcap_usd };
const optionalTwap = { twap_slices: A.twap_slices.optional(), twap_interval_s: A.twap_interval_s.optional() };
const trade = {
  input: z.string().describe('what to spend: a mint, or SOL, USDC, USDT'),
  output: z.string().describe('what to get: a mint, or SOL, USDC, USDT'),
  amount: raw.optional().describe('raw units of the input (lamports for SOL). Give this or holdings_bps'),
  holdings_bps: int(1, 10_000).optional().describe("or a share of the wallet's balance of the input, 10000 = all"),
  slippage_bps: A.slippage_bps,
};
const twapObject = z.object({ slices: A.twap_slices, interval_s: A.twap_interval_s });

// ---------------------------------------------------------------- the wallet and its link

const walletView = () => ({
  wallet: client.wallet, api: client.cfg.apiUrl, connected: client.connected, dry_run: client.cfg.dryRun,
  skip_spend_check: client.cfg.skipSpendCheck, orders_known: Object.keys(client.state.orders).length,
  plans_known: Object.keys(client.state.plans).length,
});
tool('wallet', "This MCP's wallet address and its link to onestop: whether it's logged in to the engine, the API it uses, "
  + "whether dry run is on, and how many orders and plans it's tracking. No network call. Call it first: every other "
  + 'tool acts for this wallet.', {}, async () => walletView());
tool('connect', 'Wait up to 20 seconds for the engine login, then report the same as wallet. The MCP logs in by itself at '
  + 'start and again after any drop, backing off up to 30 seconds between tries, so use this to wait for it rather '
  + 'than retrying another tool.', {}, async () => (await client.connect(), walletView()));

// ---------------------------------------------------------------- swaps and data

tool('quote', 'Price a swap without trading. Returns amount_in, expected_out, min_out, the fee (1%) and the gas (both taken '
  + 'from the trade), and transaction.base64: the unsigned transaction, good for about 45 seconds. Nothing is signed or '
  + 'sent. Pass the transaction to submit_swap to trade it after looking at the quote, or use swap to do both at once.',
  trade, (a) => client.quote(a));
tool('submit_swap', 'Trade a transaction from quote. The MCP checks it with the guard first, simulating it on the '
  + "wallet's own RPC: onestop pays the fee, only this wallet signs besides it, nothing approves or reassigns the "
  + "wallet's accounts, the wallet loses no more than the quote says, and the output arrives. Then it signs, sends it "
  + "through onestop's MEV-protected lane and waits for it to land. Only a transaction this MCP quoted recently is "
  + "accepted, because the guard needs its quote and onestop co-signs only trades it quoted. Returns confirmed with "
  + "the signature and the wallet's balance changes, or refused with the guard's reasons. With dry run it stops after "
  + 'the guard.', { transaction: z.string().describe('transaction.base64 from a quote') }, (a) => client.submitSwap(a.transaction));
tool('swap', 'Swap now in one call: quote, guard, sign and send, the same as quote followed by submit_swap. No SOL needed '
  + 'for gas: onestop pays it and takes it, with the 1% fee, from the trade. Returns the amounts and the result: '
  + "confirmed with the signature and balance changes, refused with the guard's reasons, or dry_run.", trade, async (a) => {
  const q = await client.quote(a);
  return { quote: { amount_in: q.amount_in, expected_out: q.expected_out, min_out: q.min_out, fee: q.fee, gas: q.gas },
    result: await client.guardSignSubmit(q) };
});
tool('tokens', 'Price, market cap, liquidity and main pool for up to 100 tokens. Read only.',
  { mints: z.array(z.string()).min(1).max(100).describe('token mint addresses') },
  (a) => client.rest(`/v1/tokens?mints=${encodeURIComponent(a.mints.join(','))}`));
tool('holdings', "A wallet's SOL and token balances, valued in USD. Read only.",
  { wallet: z.string().optional().describe("the wallet to look at, default this MCP's") },
  (a) => client.rest(`/v1/wallets/${a.wallet ?? client.wallet}/holdings`));

// ---------------------------------------------------------------- orders

const ORDER_TOOLS = [
  ['limit_order', 'limit', 'A limit order: buy or sell when the market cap crosses a level, given as target_bps of the market '
    + 'cap now (above it, a take profit or a breakout buy; below it, a stop loss or a dip buy) or as target_mcap_usd. It '
    + 'fires only on a cross after placement. Add twap_slices and twap_interval_s to fill in slices.',
  { ...order, ...level, ...optionalTwap, ...extras }],
  ['trailing_order', 'trailing', 'A trailing order: a sell follows the market cap up and fires when it falls trail_bps from '
    + 'its high; a buy follows it down and fires when it rises trail_bps from its low. Add twap_slices and '
    + 'twap_interval_s to fill in slices.', { ...order, trail_bps: A.trail_bps, ...optionalTwap, ...extras }],
  ['limit_trailing_order', 'limit_trailing', 'A limit, then a trail: it waits for the market cap to reach the level '
    + '(target_bps of the market cap now, or target_mcap_usd), then trails from there and fires when the market cap '
    + 'moves back trail_bps from its best. A sell above the market cap now lets a winner run past the target and keeps '
    + 'the gain. Add twap_slices and twap_interval_s to fill in slices.',
  { ...order, ...level, trail_bps: A.trail_bps, ...optionalTwap, ...extras }],
  ['twap_order', 'now', 'A TWAP order: buy or sell now in twap_slices swaps twap_interval_s seconds apart, to spread the '
    + "price impact. Each slice is what's left divided by the slices left.",
  { ...order, twap_slices: A.twap_slices, twap_interval_s: A.twap_interval_s, ...extras }],
];
for (const [name, type, about, shape] of ORDER_TOOLS) {
  tool(name, `${about} ${UNITS} Returns the order with its order_id; follow it with get_order. ${SIGNING}`, shape,
    (a) => client.placeOrder(orderBody(type, a)), true);
}
tool('list_orders', "This wallet's orders, newest first. An order is waiting, armed (trailing from its best), filling, "
  + 'then filled, cancelled, expired or failed.', {}, () => client.request('list_orders'));
tool('get_order', 'One order: its status, trigger levels, the market cap it saw last, its slices and its fills with their '
  + 'signatures.', { order_id: A.order_id }, (a) => client.request('get_order', a));
tool('cancel_order', "Cancel an order. A slice that's already signed can't be called back; the rest of the order stops. A "
  + "plan's orders are cancelled with cancel_plan.", { order_id: A.order_id }, (a) => client.request('cancel_order', a));
tool('extend_order', "Set an open order's expiry to expires_h hours from now.",
  { order_id: A.order_id, expires_h: hours.describe('hours from now until it lapses') }, (a) => client.request('extend_order', a), true);

// ---------------------------------------------------------------- plans

tool('place_plan', 'A plan: an entry buy, then an exit onestop creates for exactly the tokens the entry bought. protect '
  + "arms once the market cap reaches arm_bps of the entry's (30000 = 3x) and then sells when it falls trail_bps from "
  + 'its high. exit takes profit at target_bps of the entry market cap, or shapes the protected sell (twap, and '
  + 'sell_bps of the tokens); with neither level the exit sells at once. A plan needs protect or exit. To protect tokens '
  + "already held, leave out entry and give amount or holdings_bps. Returns the plan with its plan_id; follow it with "
  + `get_plan. ${SIGNING}`, {
  mint: A.mint,
  entry: z.object({
    amount: raw.describe('the SOL to spend, in lamports'),
    trigger: z.object({ type: z.enum(['now', 'limit', 'trailing', 'limit_trailing']), target_bps: A.target_bps,
      target_mcap_usd: A.target_mcap_usd, trail_bps: A.trail_bps.optional() }).describe('when to buy, as in the order tools'),
    twap: twapObject.optional(),
  }).optional().describe('the buy; leave it out to protect tokens already held'),
  protect: z.object({ arm_bps: int(1, 1_000_000).describe('arms at this share of the entry market cap: 30000 = 3x'),
    trail_bps: A.trail_bps }).optional()
    .describe('a trailing stop that arms at arm_bps of the entry market cap'),
  exit: z.object({ target_bps: A.target_bps, twap: twapObject.optional(), sell_bps: int(1, 10_000).optional()
    .describe('the share of the tokens to sell, default 10000 = all') }).optional()
    .describe('a take profit at target_bps of the entry market cap, and how the exit sells: twap, sell_bps of the tokens (default all)'),
  amount: raw.optional().describe('without an entry: raw units of the token already held'),
  holdings_bps: int(1, 10_000).optional().describe("without an entry: or a share of the wallet's balance of it"),
  ...extras,
}, (a) => client.placePlan(a), true);
tool('get_plan', "A plan's progress: the entry's fills, the tokens it bought and its average entry market cap, the exit "
  + '(armed with its high and stop, or its take-profit level), and the market cap now as a multiple of the entry.',
  { plan_id: A.plan_id }, (a) => client.request('get_plan', a));
tool('cancel_plan', "Cancel a plan and every stage that hasn't run. Tokens already bought stay in the wallet.",
  { plan_id: A.plan_id }, (a) => client.request('cancel_plan', a));

tool('activity', 'What this MCP did since it started, newest first: fills it signed (with signatures) or refused (with the '
  + 'reason), paper fills, exits it took on, and order and plan updates.',
  { limit: int(1, 100).optional().describe('how many entries, default 20') },
  async (a) => ({ activity: client.activity.slice(0, a.limit ?? 20) }));

await server.connect(new StdioServerTransport());
process.stdin.on('end', () => process.exit(0));  // the agent's client went away; the open socket would keep us alive
