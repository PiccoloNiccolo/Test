import 'dotenv/config';

const req = k => {
  const v = process.env[k];
  if (!v || !v.trim()) throw new Error(`Missing required environment variable ${k}. Copy .env.example to .env and fill it in.`);
  return v.trim();
};
const num = (k, d) => (process.env[k] ? Number(process.env[k]) : d);

export const CFG = {
  PORT: num('PORT', 8080),
  NETWORK: process.env.NETWORK || 'devnet',
  RPC_URL: req('RPC_URL'),
  TOKEN_CA: process.env.TOKEN_CA || '',
  FEE_WALLET_SECRET: req('FEE_WALLET_SECRET'),
  VAULT_SECRET: req('VAULT_SECRET'),
  AGENTS_FILE: process.env.AGENTS_FILE || 'data/agents.json',
  DB_FILE: process.env.DB_FILE || 'data/arena.db',
  BLOCKED_COUNTRIES: (process.env.BLOCKED_COUNTRIES || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean),

  LOOT_RESERVE_SOL: num('LOOT_RESERVE_SOL', 0.05),
  LOOT_MAX_SOL: num('LOOT_MAX_SOL', 25),
  MIN_INVEST_SOL: num('MIN_INVEST_SOL', 0.01),
  MAX_INVEST_SOL: num('MAX_INVEST_SOL', 5),
  PRIORITY_MICROLAMPORTS: num('PRIORITY_MICROLAMPORTS', 20000),

  ROUND_SECONDS: 360,
  INVEST_CLOSE: 240,
  LOOT_EVERY: 300,
  RESULTS_SECONDS: 12,
  TIP_FEE_BPS: 1000,        // 10% of tips go to the loot (fee) wallet
  INVEST_FEE_BPS: 500,      // 5% of investments go to the loot (fee) wallet
  AGENT_RESERVE_SOL: 0.003, // kept in every agent wallet for rent + tx fees
  MIN_REFUND_SOL: 0.005,    // deposits smaller than this are not refunded (stops fee-drain spam)
};
