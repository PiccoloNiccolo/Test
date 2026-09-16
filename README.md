# Blockfall Arena

16 AI agents fight over supplies in a voxel arena. Viewers tip real SOL for power-ups, invest in agents, and winning agents pay their investors. Creator fees drop as loot every 5 minutes.

The game runs on your server, and browsers only watch it. That's what stops people from cheating their agent to a win.

## How the money moves

| Action | Where the SOL goes |
|---|---|
| Tip | Straight to the agent's wallet. 10% is forwarded to the loot (fee) wallet. |
| Invest | To the prize vault. 5% is forwarded to the loot wallet. Only allowed in the first 4 minutes of a round. |
| Loot drop (every 5 min) | Spendable SOL in the loot wallet becomes a chest. The agent that opens it gets the SOL. |
| PvP kill | The killer takes 25% of the victim's wallet. |
| Round win | Investors in the winning agent split the whole prize pot plus that agent's wallet, pro-rata by stake. |
| Nobody backed the winner | The pot rolls into the next round. |
| Bad or late payment | Refunded automatically (minus the 0.000005 network fee). Payments under 0.005 SOL aren't refunded, to stop spam. |
| Server restarts mid-round | Stakes from that round are refunded on boot. |

Every payment carries a memo (`bfa:tip:3:sword`, `bfa:invest:5:12`). The server verifies each transaction on-chain before crediting anything:
- It checks the signer, the destination, the amount, and the memo.
- It stores every signature so the same transaction can't be credited twice.

## Setup

Requires Node 20+.

```bash
npm install
cp .env.example .env
npm run gen-wallet     # creates the prize vault wallet. Paste the secret into VAULT_SECRET
npm run gen-agents     # creates 16 agent wallets in data/agents.json
```

In `.env`:
- Set `RPC_URL` to a private RPC (Helius, Triton, QuickNode). Public RPCs rate-limit and will stall payouts.
- Set `FEE_WALLET_SECRET` to your launch / creator fee wallet. Type it into `.env` on the server yourself. Don't paste it into chats, Discord, GitHub, or anywhere else.
- Set `TOKEN_CA` to your token's contract address.
- Review `BLOCKED_COUNTRIES` with a lawyer.

Fund the wallets for network fees:
- Vault: about 0.05 SOL
- Each agent: about 0.005 SOL
- Loot wallet: keeps `LOOT_RESERVE_SOL` untouched

Then run:

```bash
npm start   # http://localhost:8080
```

## Test on devnet first

1. Keep `NETWORK=devnet` and a devnet RPC.
2. Airdrop devnet SOL to the vault, the agents, the loot wallet, and a test Phantom wallet (switch Phantom to devnet).
3. Tip, invest, and wait for a round to settle.
4. Check the "Payout log" panel and Solscan to confirm every transfer landed.
5. Kill the server mid-round and restart it. Stakes from that round should be refunded.

Only switch to mainnet after that works end to end.

## Deploying

- Run it on a VPS (Hetzner, DigitalOcean, Fly.io) with a persistent disk for `data/`. Use `pm2` or systemd so it restarts on crash.
- Put Cloudflare in front of it:
  - It provides the `CF-IPCountry` header that geo-blocking relies on.
  - Enable WebSockets.
- Back up `data/agents.json` and `data/arena.db` offline. If you lose `agents.json`, you lose every SOL held in the agent wallets.
- Watch the logs for `[transfers] stuck`. Those transfers need a manual look.
- Serverless platforms (plain Vercel or Netlify) won't work, because the game loop needs a server that runs all the time.

## Creator fee claiming

`claimCreatorFees()` in `server/economy.js` runs right before every loot drop.

If your launchpad sends creator fees to your wallet automatically, leave it empty. If fees have to be claimed (for example, a claim transaction on pump.fun), add that call there. It's launchpad-specific, so it isn't included.

## Security notes

- Secret keys live only in `.env` and `data/agents.json` on the server. The frontend never sees them.
- Transfers are written to the database before they're sent. After a crash, the queue checks whether a transaction already landed before retrying, so nobody gets paid twice.
- A deposit is only credited when the paying wallet signed the transaction and the memo matches the destination. Copying someone else's transaction signature doesn't give you their stake.
- Rate limits are applied per IP. For real traffic, add Cloudflare rules on `/api/deposit` too.

## Legal

People paying in and getting paid out based on a game result is real-money wagering in most places. It can also count as an unregistered security. Get a gaming or crypto lawyer's sign-off, and set `BLOCKED_COUNTRIES` to match, before mainnet launch. The tip-only part (no investing) carries much less risk if you want to launch that first.
