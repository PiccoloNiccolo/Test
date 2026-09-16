import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import fs from 'node:fs';
import path from 'node:path';
import 'dotenv/config';
import { ROSTER } from '../server/roster.js';

const file = process.argv[2] || process.env.AGENTS_FILE || 'data/agents.json';
if (fs.existsSync(file)) {
  console.error(`${file} already exists. Refusing to overwrite agent wallets (they may hold SOL).`);
  process.exit(1);
}
fs.mkdirSync(path.dirname(file), { recursive: true });
const out = ROSTER.map(r => {
  const k = Keypair.generate();
  return { name: r.name, address: k.publicKey.toBase58(), secret: bs58.encode(k.secretKey) };
});
fs.writeFileSync(file, JSON.stringify(out, null, 2), { mode: 0o600 });
for (const a of out) console.log(`${a.name.padEnd(16)} ${a.address}`);
console.log(`\nSaved ${out.length} agent wallets to ${file}.`);
console.log('Back this file up offline. Never commit it. Send each agent about 0.005 SOL for fees before launch.');
