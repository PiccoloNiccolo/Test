import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { PublicKey } from '@solana/web3.js';
import { CFG } from './config.js';
import { openDb } from './db.js';
import { Sol, loadKeypair, MEMO_PROGRAM } from './solana.js';
import { Game, PERKS, BP } from './game.js';
import { Economy, L } from './economy.js';
import { ROSTER } from './roster.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.on('unhandledRejection', e => console.error('[unhandledRejection]', e));

/* ---------- boot ---------- */
const agentsFile = path.resolve(root, CFG.AGENTS_FILE);
if (!fs.existsSync(agentsFile)) { console.error(`No agent wallets at ${agentsFile}. Run: npm run gen-agents`); process.exit(1); }
const agentData = JSON.parse(fs.readFileSync(agentsFile, 'utf8'));
if (agentData.length !== ROSTER.length) { console.error(`agents.json has ${agentData.length} wallets but the roster has ${ROSTER.length} agents.`); process.exit(1); }

const db = openDb(path.resolve(root, CFG.DB_FILE));
const sol = new Sol(CFG, db, agentData.map(a => loadKeypair(a.secret)));
try { await sol.refreshBalances(); } catch (e) { console.warn('[boot] could not load balances yet:', e.message); }

const startRound = db.getKv('round', 0) + 1;
db.setKv('round', startRound);
const game = new Game(ROSTER, CFG, startRound);
game.on('roundStart', r => db.setKv('round', r));
const econ = new Economy(game, sol, db, CFG);
econ.refundUnsettled();
sol.kick(); // resume any transfers left over from a crash

console.log(`[boot] ${CFG.NETWORK} | vault ${sol.addr('vault')} | loot wallet ${sol.addr('fee')} | round ${startRound}`);

const publicCfg = () => ({
  network: CFG.NETWORK, tokenCa: CFG.TOKEN_CA, vault: sol.addr('vault'), lootWallet: sol.addr('fee'), memoProgram: MEMO_PROGRAM,
  perks: PERKS, minInvest: CFG.MIN_INVEST_SOL, maxInvest: CFG.MAX_INVEST_SOL, tipFeeBps: CFG.TIP_FEE_BPS, investFeeBps: CFG.INVEST_FEE_BPS,
  roundSeconds: CFG.ROUND_SECONDS, investClose: CFG.INVEST_CLOSE, lootEvery: CFG.LOOT_EVERY, agentReserve: L(CFG.AGENT_RESERVE_SOL), bpLen: BP.length,
});

/* ---------- http ---------- */
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '4kb' }));

const countryOf = req => String(req.headers['cf-ipcountry'] || req.headers['x-vercel-ip-country'] || '').toUpperCase();
app.use((req, res, next) => {
  if (!CFG.BLOCKED_COUNTRIES.includes(countryOf(req))) return next();
  const msg = 'Blockfall Arena is not available in your region.';
  return req.path.startsWith('/api') ? res.status(451).json({ error: msg }) : res.status(451).type('html').send(`<h1>${msg}</h1>`);
});

const hits = new Map();
const limit = (max, windowMs) => (req, res, next) => {
  const key = req.ip + '|' + req.route.path, now = Date.now();
  const h = hits.get(key) || { n: 0, reset: now + windowMs };
  if (now > h.reset) { h.n = 0; h.reset = now + windowMs; }
  h.n++; hits.set(key, h);
  if (h.n > max) return res.status(429).json({ error: 'Too many requests. Wait a moment and try again.' });
  next();
};
setInterval(() => { const now = Date.now(); for (const [k, h] of hits) if (now > h.reset) hits.delete(k); }, 60_000).unref();

app.use(express.static(path.join(root, 'public'), { maxAge: '5m' }));

app.get('/api/config', (req, res) => res.json(publicCfg()));

let bhCache = null;
app.get('/api/blockhash', limit(60, 60_000), async (req, res) => {
  try {
    if (!bhCache || Date.now() - bhCache.at > 10_000) bhCache = { at: Date.now(), v: await sol.latestBlockhash() };
    res.json(bhCache.v);
  } catch (e) { res.status(503).json({ error: 'The Solana RPC is unavailable. Try again shortly.' }); }
});

app.post('/api/deposit', limit(40, 60_000), async (req, res) => {
  try { res.json(await econ.handleDeposit(String(req.body?.signature || ''))); }
  catch (e) { console.error('[deposit]', e); res.status(503).json({ status: 'pending', message: 'Could not check the transaction yet. It will be picked up automatically.' }); }
});

const walletParam = req => { try { return new PublicKey(req.params.wallet).toBase58(); } catch { return null; } };
app.get('/api/me/:wallet', limit(30, 60_000), (req, res) => {
  const w = walletParam(req); if (!w) return res.status(400).json({ error: 'Invalid wallet address.' });
  res.json({ round: game.round, stakes: db.walletStakes(game.round, w), payouts: db.payoutsFor(w), deposits: db.depositsFor(w) });
});
app.get('/api/balance/:wallet', limit(30, 60_000), async (req, res) => {
  const w = walletParam(req); if (!w) return res.status(400).json({ error: 'Invalid wallet address.' });
  try { res.json({ lamports: await sol.conn.getBalance(new PublicKey(w), 'confirmed') }); }
  catch { res.status(503).json({ error: 'Balance unavailable.' }); }
});
app.get('/api/audit', limit(30, 60_000), (req, res) => {
  res.json(db.recentTransfers(60).map(t => ({ ...t, from: t.from_key === 'vault' ? 'vault' : t.from_key === 'fee' ? 'loot wallet' : ROSTER[+t.from_key.split(':')[1]]?.name })));
});
app.get('/healthz', (req, res) => res.json({ ok: true, round: game.round, mode: game.mode }));

/* ---------- websocket ---------- */
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 512 });
const hello = () => ({ k: 'h', d: { cfg: publicCfg(), roster: ROSTER.map((r, i) => ({ ...r, addr: sol.addr('agent:' + i) })) } });
const worldMsg = () => {
  const totals = Array(ROSTER.length).fill(0);
  for (const s of db.stakeTotals(game.round)) totals[s.agent] = s.lamports;
  return { k: 'w', d: { ...game.world(), pot: econ.pot, stakes: totals, balances: ROSTER.map((_, i) => econ.agentAvail(i)), lootFund: Math.max(0, econ.lootFund()) } };
};
wss.on('connection', (ws, req) => {
  if (CFG.BLOCKED_COUNTRIES.includes(countryOf(req))) return ws.close(4003, 'region');
  ws.send(JSON.stringify(hello()));
  ws.send(JSON.stringify(worldMsg()));
  ws.on('message', () => {}); // clients never send game input
});
const broadcast = obj => {
  const s = JSON.stringify(obj);
  for (const c of wss.clients) if (c.readyState === 1 && c.bufferedAmount < 512_000) c.send(s);
};
game.on('feed', (text, kind) => broadcast({ k: 'f', d: { text, kind } }));
game.on('pop', p => broadcast({ k: 'p', d: p }));
game.on('roundEnd', ({ round, winner, ranked }) => broadcast({ k: 'r', d: { round, winner: winner.i, top: ranked.slice(0, 5).map(a => [a.i, game.score(a)]) } }));

/* ---------- loops ---------- */
let last = performance.now();
setInterval(() => {
  const now = performance.now();
  let dt = Math.min(1, (now - last) / 1000); last = now;
  while (dt > 0) { const s = Math.min(.05, dt); game.step(s); dt -= s; }
}, 50);
setInterval(() => broadcast({ k: 't', d: game.tick() }), 100);
setInterval(() => broadcast(worldMsg()), 1000);
setInterval(() => sol.refreshBalances().catch(e => console.warn('[balances]', e.message)), 15_000);
setInterval(() => econ.scan().catch(e => console.warn('[scan]', e.message)), 30_000);
setInterval(() => sol.kick(), 10_000);

server.listen(CFG.PORT, () => console.log(`[boot] Blockfall Arena on http://localhost:${CFG.PORT}`));
