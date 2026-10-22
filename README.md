# onestop MCP

Lets an AI agent trade Solana tokens through onestop: gasless swaps (no SOL needed; a 1% fee plus the
network cost, both taken from the trade), market-cap orders (limit, trailing, limit then trail, TWAP) and
plans that buy and then protect the position. Your wallet's key stays on your machine.

```json
{ "mcpServers": { "onestop": { "command": "npx", "args": ["-y", "@onestop-trade/onestop-mcp"],
    "env": { "ONESTOP_PRIVATE_KEY": "your-wallet-private-key" } } } }
```

Node 20.18 or later.

| Setting | |
|---|---|
| `ONESTOP_PRIVATE_KEY` or `ONESTOP_KEYPAIR_PATH` | the wallet that trades: its private key as your wallet exports it (Phantom: *Settings → your account → Show private key*), or the path to a keypair file. Use a wallet you keep for trading |
| `SOLANA_RPC_URL` | your RPC, used to simulate every transaction before signing (default: public mainnet) |
| `ONESTOP_DRY_RUN=1` | trade nothing: order and plan tools answer without calling onestop, and swaps stop after the guard. Paper orders still run |
| `ONESTOP_SKIP_SPEND_CHECK=1` | turn off the guard's balance checks (the structural checks stay). For debugging only |
| `ONESTOP_STATE` | where the MCP keeps the orders and plans it placed (default `~/.onestop-mcp/<wallet>.json`) |
| `ONESTOP_API_URL`, `ONESTOP_SERVER_PUBKEY` (+ `_NEXT`), `ONESTOP_GAS_WALLET` | for a self-hosted engine: its URL, its signing key, its fee payer |

## Tools

Amounts are raw units (lamports for SOL); levels and shares are basis points (20000 = 2x, 10000 = all).

| | |
|---|---|
| Wallet | `wallet` (address and link, no network call), `connect` (wait for the engine login) |
| Swaps | `quote` (price it, get the unsigned transaction), `submit_swap` (trade a quoted transaction), `swap` (both in one call) |
| Market data | `tokens` (price, market cap, liquidity), `holdings` (balances in USD) |
| Orders | `limit_order`, `trailing_order`, `limit_trailing_order`, `twap_order`; each but the TWAP can also fill in slices. `list_orders`, `get_order`, `cancel_order`, `extend_order` |
| Plans | `place_plan` (an entry buy, then a protect or take-profit exit for exactly what it bought), `get_plan`, `cancel_plan` |
| Log | `activity`: fills signed or refused (and why), paper fills, order and plan updates |

`paper: true` on an order or plan rehearses it with real prices: fills are priced from the route and
recorded, and nothing is signed or traded.

## What it signs

Every message from onestop must carry onestop's engine signature. A fill is signed only for an order
this MCP placed, after checking onestop committed to exactly what was asked, or for the exit of one of
its plans, selling no more than the entry bought. Before signing, the transaction is simulated on your
RPC and checked: onestop's gas wallet pays the fee and your wallet is the only other signer; your SOL
can't fall by more than the quote says; no token balance falls except the one you're selling, by at most
the amount; the output arrives; no approvals, authority changes or account reassignment; nothing closes
an account you already had.

## It has to be running

onestop watches the market 24/7, but this MCP signs each fill, so it needs to be running: if it's closed
when an order fires, the fill waits and runs when it's back, at the price then.
