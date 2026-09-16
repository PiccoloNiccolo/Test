import { Connection, Keypair, PublicKey, SystemProgram, Transaction, ComputeBudgetProgram } from '@solana/web3.js';
import bs58 from 'bs58';

export const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const TX_FEE_ESTIMATE = 10_000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

export function loadKeypair(secret) {
  const s = String(secret).trim();
  const bytes = s.startsWith('[') ? Uint8Array.from(JSON.parse(s)) : bs58.decode(s);
  if (bytes.length !== 64) throw new Error('Secret key must be 64 bytes (base58 string or JSON byte array).');
  return Keypair.fromSecretKey(bytes);
}

export class Sol {
  constructor(cfg, db, agentKeypairs) {
    this.cfg = cfg;
    this.db = db;
    this.conn = new Connection(cfg.RPC_URL, 'confirmed');
    this.keys = { vault: loadKeypair(cfg.VAULT_SECRET), fee: loadKeypair(cfg.FEE_WALLET_SECRET) };
    agentKeypairs.forEach((k, i) => { this.keys['agent:' + i] = k; });
    this.nameByAddr = new Map(Object.entries(this.keys).map(([n, k]) => [k.publicKey.toBase58(), n]));
    if (this.nameByAddr.size !== Object.keys(this.keys).length) throw new Error('Vault, fee wallet and agent wallets must all be different addresses.');
    this.balances = {};
    this.busy = false;
  }

  addr(name) { return this.keys[name].publicKey.toBase58(); }

  async refreshBalances() {
    const names = Object.keys(this.keys);
    const infos = await this.conn.getMultipleAccountsInfo(names.map(n => this.keys[n].publicKey), 'confirmed');
    names.forEach((n, i) => { this.balances[n] = infos[i]?.lamports ?? 0; });
  }

  /** Spendable lamports: on-chain balance minus queued outgoing transfers minus a reserve. */
  available(name, reserveLamports = 0) {
    return Math.max(0, (this.balances[name] || 0) - this.db.pendingOut(name) - reserveLamports);
  }

  async latestBlockhash() { return this.conn.getLatestBlockhash('confirmed'); }

  /** Reads a confirmed transaction and extracts memo, top-level SOL transfers and signers. */
  async verifyDeposit(sig) {
    const tx = await this.conn.getParsedTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
    if (!tx) return { status: 'notfound' };
    if (tx.meta?.err) return { status: 'failed' };
    const ixs = tx.transaction.message.instructions;
    const memoIx = ixs.find(ix => ix.programId?.toBase58?.() === MEMO_PROGRAM || ix.program === 'spl-memo');
    const memo = memoIx && typeof memoIx.parsed === 'string' ? memoIx.parsed : null;
    const transfers = ixs
      .filter(ix => ix.program === 'system' && ix.parsed?.type === 'transfer')
      .map(ix => ({ source: ix.parsed.info.source, destination: ix.parsed.info.destination, lamports: Number(ix.parsed.info.lamports) }));
    const signers = tx.transaction.message.accountKeys.filter(k => k.signer).map(k => k.pubkey.toBase58());
    return { status: 'ok', memo, transfers, signers, blockTime: tx.blockTime };
  }

  /** Adds a transfer to the persistent queue. Returns the transfer id (or null if skipped). */
  enqueue(fromName, toAddr, lamports, reason, { kick = true } = {}) {
    lamports = Math.floor(lamports);
    if (!(lamports > 0)) return null;
    if (!this.keys[fromName]) throw new Error('Unknown wallet ' + fromName);
    new PublicKey(toAddr); // throws on a bad address
    const id = this.db.addTransfer(fromName, toAddr, lamports, reason);
    if (kick) this.kick();
    return id;
  }

  kick() {
    if (this.busy) return;
    this.busy = true;
    (async () => {
      try {
        let tr;
        while ((tr = this.db.nextTransfer())) await this.process(tr);
      } catch (e) {
        console.error('[transfers] queue error', e);
      } finally {
        this.busy = false;
      }
    })();
  }

  async process(tr) {
    const kp = this.keys[tr.from_key];
    // A previous attempt was signed and maybe sent. Never resend until we're sure it can't land.
    if (tr.status === 'sending' && tr.sig) {
      try {
        const { value } = await this.conn.getSignatureStatus(tr.sig, { searchTransactionHistory: true });
        if (value && !value.err && ['confirmed', 'finalized'].includes(value.confirmationStatus)) return this.finish(tr, tr.sig);
        if (value?.err) { this.db.setTransferStatus(tr.id, 'failed', JSON.stringify(value.err)); return; }
        const height = await this.conn.getBlockHeight('confirmed');
        if (height <= tr.last_valid) { await sleep(2500); return; } // could still land, check again
      } catch (e) {
        this.db.noteTransferError(tr.id, String(e.message || e)); await sleep(3000); return;
      }
      // blockhash expired and the tx never landed: safe to rebuild
    }
    if (tr.attempts >= 5) { this.db.setTransferStatus(tr.id, 'stuck', 'Too many attempts. Check manually.'); console.error('[transfers] stuck', tr); return; }

    try {
      const { blockhash, lastValidBlockHeight } = await this.conn.getLatestBlockhash('confirmed');
      const tx = new Transaction({ feePayer: kp.publicKey, blockhash, lastValidBlockHeight }).add(
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: this.cfg.PRIORITY_MICROLAMPORTS }),
        SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: new PublicKey(tr.to_addr), lamports: tr.lamports }),
      );
      tx.sign(kp);
      const sig = bs58.encode(tx.signature);
      this.db.markSending(tr.id, sig, lastValidBlockHeight); // persist BEFORE sending so a crash can't cause a double pay
      await this.conn.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
      const res = await this.conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
      if (res.value.err) this.db.setTransferStatus(tr.id, 'failed', JSON.stringify(res.value.err));
      else this.finish(tr, sig);
    } catch (e) {
      const msg = String(e.message || e);
      if (/insufficient (funds|lamports)|0x1\b|rent/i.test(msg)) {
        this.db.setTransferStatus(tr.id, 'failed', msg);
        console.error(`[transfers] #${tr.id} ${tr.from_key} -> ${tr.to_addr} failed: ${msg}`);
      } else {
        this.db.noteTransferError(tr.id, msg);
        await sleep(2000);
      }
    }
  }

  finish(tr, sig) {
    this.db.markSent(tr.id, sig);
    this.balances[tr.from_key] = Math.max(0, (this.balances[tr.from_key] || 0) - tr.lamports - TX_FEE_ESTIMATE);
    const toName = this.nameByAddr.get(tr.to_addr);
    if (toName) this.balances[toName] = (this.balances[toName] || 0) + tr.lamports;
    console.log(`[transfers] #${tr.id} ${tr.reason} ${tr.lamports} lamports ${tr.from_key} -> ${tr.to_addr} ${sig}`);
  }
}
