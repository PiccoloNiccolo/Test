import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export function openDb(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS deposits(
      sig TEXT PRIMARY KEY, wallet TEXT, kind TEXT, agent INTEGER, detail TEXT,
      lamports INTEGER, round INTEGER, status TEXT, note TEXT, created INTEGER);
    CREATE INDEX IF NOT EXISTS deposits_wallet ON deposits(wallet, created);
    CREATE TABLE IF NOT EXISTS stakes(
      round INTEGER, agent INTEGER, wallet TEXT, lamports INTEGER, settled INTEGER DEFAULT 0,
      PRIMARY KEY(round, agent, wallet));
    CREATE TABLE IF NOT EXISTS transfers(
      id INTEGER PRIMARY KEY AUTOINCREMENT, from_key TEXT, to_addr TEXT, lamports INTEGER, reason TEXT,
      status TEXT, sig TEXT, last_valid INTEGER, attempts INTEGER DEFAULT 0, error TEXT,
      created INTEGER, updated INTEGER);
    CREATE INDEX IF NOT EXISTS transfers_status ON transfers(status, id);
    CREATE TABLE IF NOT EXISTS payouts(round INTEGER, wallet TEXT, agent INTEGER, lamports INTEGER, transfer_id INTEGER);
    CREATE INDEX IF NOT EXISTS payouts_wallet ON payouts(wallet);
    CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY, value TEXT);
  `);
  const now = () => Date.now();
  const st = {
    kvGet: db.prepare('SELECT value FROM kv WHERE key=?'),
    kvSet: db.prepare('INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'),
    depGet: db.prepare('SELECT * FROM deposits WHERE sig=?'),
    depIns: db.prepare(`INSERT OR IGNORE INTO deposits(sig,wallet,kind,agent,detail,lamports,round,status,note,created)
                        VALUES(@sig,@wallet,@kind,@agent,@detail,@lamports,@round,@status,@note,@created)`),
    depFor: db.prepare('SELECT sig,kind,agent,detail,lamports,round,status,note,created FROM deposits WHERE wallet=? ORDER BY created DESC LIMIT 20'),
    stakeAdd: db.prepare(`INSERT INTO stakes(round,agent,wallet,lamports) VALUES(?,?,?,?)
                          ON CONFLICT(round,agent,wallet) DO UPDATE SET lamports=lamports+excluded.lamports`),
    stakesFor: db.prepare('SELECT * FROM stakes WHERE round=? AND settled=0'),
    stakeTotals: db.prepare('SELECT agent, SUM(lamports) AS lamports FROM stakes WHERE round=? GROUP BY agent'),
    walletStakes: db.prepare('SELECT agent, lamports FROM stakes WHERE round=? AND wallet=?'),
    unsettled: db.prepare('SELECT * FROM stakes WHERE settled=0'),
    settleRound: db.prepare('UPDATE stakes SET settled=1 WHERE round=?'),
    settleAll: db.prepare('UPDATE stakes SET settled=1 WHERE settled=0'),
    trAdd: db.prepare(`INSERT INTO transfers(from_key,to_addr,lamports,reason,status,created,updated) VALUES(?,?,?,?, 'pending', ?, ?)`),
    trNext: db.prepare(`SELECT * FROM transfers WHERE status IN ('pending','sending') ORDER BY id LIMIT 1`),
    trSending: db.prepare(`UPDATE transfers SET status='sending', sig=?, last_valid=?, attempts=attempts+1, updated=? WHERE id=?`),
    trSent: db.prepare(`UPDATE transfers SET status='sent', sig=COALESCE(?, sig), error=NULL, updated=? WHERE id=?`),
    trStatus: db.prepare(`UPDATE transfers SET status=?, error=?, updated=? WHERE id=?`),
    trError: db.prepare(`UPDATE transfers SET error=?, updated=? WHERE id=?`),
    trPendingOut: db.prepare(`SELECT COALESCE(SUM(lamports),0) AS s FROM transfers WHERE from_key=? AND status IN ('pending','sending')`),
    trRecent: db.prepare(`SELECT id, from_key, to_addr, lamports, reason, status, sig, updated FROM transfers ORDER BY id DESC LIMIT ?`),
    payAdd: db.prepare('INSERT INTO payouts(round,wallet,agent,lamports,transfer_id) VALUES(?,?,?,?,?)'),
    payFor: db.prepare(`SELECT p.round, p.agent, p.lamports, t.status, t.sig FROM payouts p LEFT JOIN transfers t ON t.id=p.transfer_id
                        WHERE p.wallet=? ORDER BY p.round DESC LIMIT 30`),
  };

  return {
    getKv: (k, d) => { const r = st.kvGet.get(k); return r ? JSON.parse(r.value) : d; },
    setKv: (k, v) => st.kvSet.run(k, JSON.stringify(v)),

    getDeposit: sig => st.depGet.get(sig),
    insertDeposit: d => st.depIns.run({ wallet:null, kind:null, agent:null, detail:null, lamports:0, round:null, note:null, ...d, created: now() }).changes === 1,
    depositsFor: w => st.depFor.all(w),

    addStake: (round, agent, wallet, lamports) => st.stakeAdd.run(round, agent, wallet, lamports),
    stakesFor: round => st.stakesFor.all(round),
    stakeTotals: round => st.stakeTotals.all(round),
    walletStakes: (round, w) => st.walletStakes.all(round, w),
    unsettledStakes: () => st.unsettled.all(),
    markSettled: round => st.settleRound.run(round),
    settleAll: () => st.settleAll.run(),

    addTransfer: (from, to, lamports, reason) => Number(st.trAdd.run(from, to, lamports, reason, now(), now()).lastInsertRowid),
    nextTransfer: () => st.trNext.get(),
    markSending: (id, sig, lastValid) => st.trSending.run(sig, lastValid, now(), id),
    markSent: (id, sig) => st.trSent.run(sig ?? null, now(), id),
    setTransferStatus: (id, status, err) => st.trStatus.run(status, err ?? null, now(), id),
    noteTransferError: (id, err) => st.trError.run(err, now(), id),
    pendingOut: from => st.trPendingOut.get(from).s,
    recentTransfers: (n = 50) => st.trRecent.all(n),

    addPayout: (round, wallet, agent, lamports, transferId) => st.payAdd.run(round, wallet, agent, lamports, transferId),
    payoutsFor: w => st.payFor.all(w),

    tx: fn => db.transaction(fn)(),
  };
}
