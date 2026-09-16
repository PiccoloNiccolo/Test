import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import { PERKS } from './game.js';

export const L = sol => Math.round(sol * LAMPORTS_PER_SOL);
export const fmt = lamports => { const s = lamports / LAMPORTS_PER_SOL; return '◎' + s.toFixed(s >= 10 ? 2 : 3); };
export const short = a => a.slice(0, 4) + '…' + a.slice(-4);
const SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;
// Memo formats written by the frontend:
//   bfa:tip:<agentIndex>:<perk>
//   bfa:invest:<agentIndex>:<round>
const MEMO_RE = /^bfa:(tip|invest):(\d{1,2}):([a-z]+|\d+)$/;

export class Economy {
  constructor(game, sol, db, cfg) {
    Object.assign(this, { game, sol, db, cfg });
    this.inflight = new Map();
    game.on('kill', e => this.onKill(e));
    game.on('chestDrop', c => this.game.feed(`🎁 Creator fees dropped as loot: ${fmt(c.value)}. All agents are racing to the chest.`, 'loot'));
    game.on('chestOpen', e => this.onChestOpen(e));
    game.on('roundEnd', e => this.onRoundEnd(e).catch(err => console.error('[settle] error', err)));
    game.on('lootTime', () => this.onLootTime().catch(err => console.error('[loot] error', err)));
  }

  get pot() { return this.db.getKv('pot', 0); }
  set pot(v) { this.db.setKv('pot', Math.max(0, Math.floor(v))); }
  agentKey(i) { return 'agent:' + i; }
  agentAvail(i) { return this.sol.available(this.agentKey(i), L(this.cfg.AGENT_RESERVE_SOL)); }
  lootFund() { return this.sol.available('fee', L(this.cfg.LOOT_RESERVE_SOL)) - (this.game.chest ? this.game.chest.value : 0); }

  /** After a restart, stakes from the interrupted round are refunded, since that round can never finish. */
  refundUnsettled() {
    const rows = this.db.unsettledStakes();
    if (!rows.length) return;
    let total = 0;
    this.db.tx(() => {
      for (const s of rows) { this.sol.enqueue('vault', s.wallet, s.lamports, `refund-interrupted:r${s.round}`, { kick: false }); total += s.lamports; }
      this.db.settleAll();
      this.pot = this.pot - total;
    });
    console.log(`[boot] refunded ${rows.length} stakes (${fmt(total)}) from an interrupted round`);
    this.sol.kick();
  }

  /* ---------- deposits ---------- */
  async handleDeposit(sig) {
    if (!SIG_RE.test(sig)) return { status: 'rejected', message: 'That is not a valid transaction signature.' };
    const existing = this.db.getDeposit(sig);
    if (existing) return { status: existing.status, message: existing.note || statusText(existing.status) };
    if (this.inflight.has(sig)) return this.inflight.get(sig);
    const p = this.process(sig).finally(() => this.inflight.delete(sig));
    this.inflight.set(sig, p);
    return p;
  }

  async process(sig) {
    const v = await this.sol.verifyDeposit(sig);
    if (v.status === 'notfound') return { status: 'pending', message: 'Waiting for the transaction to confirm.' };
    if (this.db.getDeposit(sig)) { const d = this.db.getDeposit(sig); return { status: d.status, message: d.note }; }
    if (v.status === 'failed') {
      this.db.insertDeposit({ sig, status: 'failed', note: 'The transaction failed on-chain. Nothing was charged except network fees.' });
      return { status: 'failed', message: 'The transaction failed on-chain. Nothing was charged except network fees.' };
    }
    const m = v.memo && v.memo.trim().match(MEMO_RE);
    if (!m) { this.db.insertDeposit({ sig, status: 'ignored', note: 'No arena instruction in this transaction.' }); return { status: 'ignored', message: 'No arena instruction in this transaction.' }; }

    const kind = m[1], agent = Number(m[2]), extra = m[3];
    const tr = v.transfers.find(t => v.signers.includes(t.source) && this.sol.nameByAddr.has(t.destination) && !this.sol.nameByAddr.has(t.source));
    if (!tr) {
      this.db.insertDeposit({ sig, kind, status: 'rejected', note: 'No SOL transfer to an arena wallet was found.' });
      return { status: 'rejected', message: 'No SOL transfer to an arena wallet was found.' };
    }
    const wallet = tr.source, lamports = tr.lamports, destName = this.sol.nameByAddr.get(tr.destination);
    const round = this.game.round;
    const base = { sig, wallet, kind, agent, detail: extra, lamports, round };

    const reject = reason => {
      const canRefund = lamports >= L(this.cfg.MIN_REFUND_SOL);
      const note = canRefund ? `${reason} Your ${fmt(lamports)} is being refunded.` : `${reason} The amount was too small to refund.`;
      if (!this.db.insertDeposit({ ...base, status: canRefund ? 'refunded' : 'rejected', note })) return { status: 'duplicate', message: 'Already processed.' };
      if (canRefund) this.sol.enqueue(destName, wallet, lamports - 5000, `refund:${sig.slice(0, 10)}`);
      return { status: canRefund ? 'refunded' : 'rejected', message: note };
    };

    const a = this.game.agents[agent];
    if (!a) return reject('Unknown agent.');

    if (kind === 'tip') {
      const perk = PERKS[extra];
      if (!perk) return reject('Unknown power-up.');
      if (destName !== this.agentKey(agent)) return reject(`That tip was sent to the wrong wallet for ${a.name}.`);
      if (lamports < L(perk.sol)) return reject(`That power-up costs ◎${perk.sol}.`);
      if (!this.db.insertDeposit({ ...base, status: 'credited', note: `Tip credited to ${a.name}.` })) return { status: 'duplicate', message: 'Already processed.' };
      const note = this.game.applyPerk(agent, extra);
      this.sol.enqueue(destName, this.sol.addr('fee'), lamports * this.cfg.TIP_FEE_BPS / 10000, `tipfee:${sig.slice(0, 10)}`);
      this.game.feed(`${short(wallet)} tipped ${a.name} ${fmt(lamports)} for ${note}`, 'tip');
      return { status: 'credited', message: `${a.name} got ${note}.` };
    }

    // invest
    if (destName !== 'vault') return reject('Investments must be sent to the prize vault.');
    if (Number(extra) !== round || !this.game.investOpen()) return reject('Investing had closed for that round by the time your transaction confirmed.');
    if (lamports < L(this.cfg.MIN_INVEST_SOL) || lamports > L(this.cfg.MAX_INVEST_SOL)) return reject(`Investments must be between ◎${this.cfg.MIN_INVEST_SOL} and ◎${this.cfg.MAX_INVEST_SOL}.`);
    const fee = Math.floor(lamports * this.cfg.INVEST_FEE_BPS / 10000), net = lamports - fee;
    let ok = false;
    this.db.tx(() => {
      ok = this.db.insertDeposit({ ...base, status: 'credited', note: `Invested ${fmt(net)} in ${a.name} after the 5% loot fee.` });
      if (!ok) return;
      this.db.addStake(round, agent, wallet, net);
      this.pot = this.pot + net;
    });
    if (!ok) return { status: 'duplicate', message: 'Already processed.' };
    this.sol.enqueue('vault', this.sol.addr('fee'), fee, `investfee:${sig.slice(0, 10)}`);
    this.game.feed(`📈 ${short(wallet)} invested ${fmt(lamports)} in ${a.name}`, 'tip');
    return { status: 'credited', message: `Invested ${fmt(net)} in ${a.name}.` };
  }

  /** Safety net: finds arena deposits whose sender closed the page before the frontend reported them. */
  async scan() {
    const names = ['vault', ...this.game.agents.map((_, i) => this.agentKey(i))];
    for (const n of names) {
      const sigs = await this.sol.conn.getSignaturesForAddress(this.sol.keys[n].publicKey, { limit: 25 }, 'confirmed');
      for (const s of sigs) {
        if (s.err || !s.memo || !s.memo.includes('bfa:')) continue;
        if (this.db.getDeposit(s.signature)) continue;
        await this.handleDeposit(s.signature).catch(e => console.warn('[scan]', s.signature, e.message));
      }
      await new Promise(r => setTimeout(r, 250));
    }
  }

  /* ---------- game money events ---------- */
  onKill({ killer, victim, supplies }) {
    const amt = Math.floor(this.agentAvail(victim.i) * .25);
    const stole = amt >= L(0.001);
    if (stole) this.sol.enqueue(this.agentKey(victim.i), this.sol.addr(this.agentKey(killer.i)), amt, `steal:r${this.game.round}`);
    this.game.feed(`☠️ ${killer.name} eliminated ${victim.name}${stole ? ` and took ${fmt(amt)}` : ''}${supplies ? ` plus ${supplies} supplies` : ''}`, 'kill');
    this.game.pop(killer.x, killer.z, `☠ +25${stole ? ' ' + fmt(amt) : ''}`, 'kill');
  }

  onChestOpen({ agent, lamports }) {
    this.sol.enqueue('fee', this.sol.addr(this.agentKey(agent.i)), lamports, `loot:r${this.game.round}`);
    this.game.feed(`🎁 ${agent.name} opened the chest and won ${fmt(lamports)}`, 'loot');
    this.game.pop(agent.x, agent.z, `🎁 +${fmt(lamports)}`, 'sol');
  }

  /** Hook: claim creator fees for TOKEN_CA from your launchpad into the fee wallet. Launchpad-specific. */
  async claimCreatorFees() {}

  async onLootTime() {
    try { await this.claimCreatorFees(); } catch (e) { console.warn('[loot] creator fee claim failed', e.message); }
    try { await this.sol.refreshBalances(); } catch (e) { console.warn('[loot] balance refresh failed, using cached balances', e.message); }
    const value = Math.min(this.lootFund(), L(this.cfg.LOOT_MAX_SOL));
    if (value < L(0.001)) { this.game.feed('🎁 The loot fund was empty this time. Tips and investments refill it.', 'loot'); return; }
    this.game.dropChest(value);
  }

  async onRoundEnd({ round, winner }) {
    try { await this.sol.refreshBalances(); } catch (e) { console.warn('[settle] balance refresh failed, using cache', e.message); }
    const stakes = this.db.stakesFor(round);
    const win = stakes.filter(s => s.agent === winner.i);
    if (!win.length) {
      this.db.markSettled(round);
      this.game.feed(`💰 Nobody backed ${winner.name}, so the ${fmt(this.pot)} pot rolls into the next round.`, 'loot');
      return;
    }
    const pot = this.pot;
    const agentExtra = this.agentAvail(winner.i);
    const totalStake = win.reduce((s, x) => s + x.lamports, 0);
    const share = (amount, stake) => Number(BigInt(amount) * BigInt(stake) / BigInt(totalStake));
    let paidPot = 0, paidAgent = 0;
    this.db.tx(() => {
      for (const s of win) {
        const fromPot = share(pot, s.lamports), fromAgent = share(agentExtra, s.lamports);
        if (fromPot > 5000) {
          const id = this.sol.enqueue('vault', s.wallet, fromPot, `payout-pot:r${round}`, { kick: false });
          this.db.addPayout(round, s.wallet, winner.i, fromPot, id); paidPot += fromPot;
        }
        if (fromAgent > 5000) {
          const id = this.sol.enqueue(this.agentKey(winner.i), s.wallet, fromAgent, `payout-agent:r${round}`, { kick: false });
          this.db.addPayout(round, s.wallet, winner.i, fromAgent, id); paidAgent += fromAgent;
        }
      }
      this.db.markSettled(round);
      this.pot = pot - paidPot;
    });
    this.sol.kick();
    this.game.feed(`💸 ${winner.name} paid ${fmt(paidPot + paidAgent)} to ${win.length} investor${win.length === 1 ? '' : 's'}`, 'loot');
  }
}

function statusText(s) {
  return { credited: 'Credited.', refunded: 'Refunded.', rejected: 'Rejected.', ignored: 'Not an arena transaction.', failed: 'Failed on-chain.' }[s] || s;
}
