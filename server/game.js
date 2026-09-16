import { EventEmitter } from 'node:events';

export const HOME_R = 29, NODE_MAX = 46, CYCLE = 180;
export const STATES = ['seek', 'mine', 'return', 'build', 'flee', 'loot', 'fight', 'dead'];
export const RT = { w: { val: 1, time: .45, wt: 45 }, s: { val: 2, time: .6, wt: 30 }, i: { val: 3, time: .8, wt: 16 }, g: { val: 5, time: 1.05, wt: 9 } };
export const PERKS = {
  boost: { sol: .1, name: 'an energy drink' },
  heal: { sol: .2, name: 'a potion and shield' },
  crate: { sol: .25, name: 'a supply crate' },
  sword: { sol: .5, name: 'a sword upgrade' },
};
const SWORD_NAME = ['wood', 'stone', 'iron', 'gold', 'crystal'];

// House blueprint (door faces local +z). The client builds the same list.
export const BP = (() => {
  const bp = [];
  for (let y = 0; y < 3; y++) for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) { if (x === 0 && z === 0) continue; if (x === 0 && z === 1 && y < 2) continue; bp.push([x, y, z]); }
  for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) bp.push([x, 3, z]);
  bp.push([0, 4, 0]);
  for (let y = 0; y < 2; y++) for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) { if (Math.abs(x) < 2 && Math.abs(z) < 2) continue; if (z === 2 && x === 0) continue; bp.push([x, y, z]); }
  for (let y = 2; y < 6; y++) for (const [x, z] of [[-2, -2], [2, -2], [-2, 2], [2, 2]]) bp.push([x, y, z]);
  return bp;
})();

const rnd = (a, b) => a + Math.random() * (b - a);
const pick = a => a[Math.random() * a.length | 0];
const dist = (ax, az, bx, bz) => Math.hypot(ax - bx, az - bz);
const lerpAngle = (a, b, k) => a + (((b - a + Math.PI * 3) % (Math.PI * 2)) - Math.PI) * k;
const r2 = v => Math.round(v * 100) / 100;

export class Game extends EventEmitter {
  constructor(roster, cfg, startRound = 1) {
    super();
    this.cfg = cfg;
    this.T = 0; this.t = 0; this.round = startRound;
    this.mode = 'race'; this.phase = 'day'; this.resultsEnd = 0;
    this.nextLoot = cfg.LOOT_EVERY; this.nextNodeSpawn = 0; this.nextMonster = 0;
    this.nodes = []; this.monsters = []; this.chest = null; this.winner = null;
    this.nid = 1; this.mid = 1;
    const n = roster.length;
    this.agents = roster.map((o, i) => {
      const ang = i / n * Math.PI * 2 + .2;
      const hx = Math.round(Math.cos(ang) * HOME_R) + .5, hz = Math.round(Math.sin(ang) * HOME_R) + .5;
      const rot = Math.round(Math.atan2(-hx, -hz) / (Math.PI / 2)) * (Math.PI / 2);
      const a = { i, isAgent: true, name: o.name, greed: o.greed, brave: o.brave, aggro: o.aggro, speed: o.speed,
        hx, hz, rot, ex: hx + Math.sin(rot) * 3.4, ez: hz + Math.cos(rot) * 3.4, wins: 0 };
      this.resetAgent(a);
      return a;
    });
    for (let k = 0; k < NODE_MAX; k++) this.spawnNode();
  }

  resetAgent(a) {
    Object.assign(a, { x: a.ex, z: a.ez, r: 0, state: 'seek', node: null, carry: [], cap: 5, hp: 100, maxhp: 100, sword: 0,
      boostUntil: 0, shieldUntil: 0, blocks: [], vault: 0, kills: 0, pvp: 0, chestPts: 0, dead: false, deadUntil: 0,
      mineT: 0, buildT: 0, crateQ: [], crateT: 0, foe: null, raidUntil: 0, swing: false, moving: false });
  }

  score(a) { return a.blocks.reduce((s, b) => s + RT[b].val, 0) + a.vault + a.kills * 15 + a.pvp * 25 + a.chestPts; }
  investOpen() { return this.mode === 'race' && this.t < this.cfg.INVEST_CLOSE; }
  phaseOf(t) { const c = t % CYCLE; return c < 110 ? 'day' : c < 120 ? 'dusk' : c < 165 ? 'night' : 'dawn'; }
  feed(text, kind) { this.emit('feed', text, kind); }
  pop(x, z, text, cls) { this.emit('pop', { x: r2(x), z: r2(z), text, cls }); }

  /* ---------- world ---------- */
  weighted() { const tot = Object.values(RT).reduce((s, r) => s + r.wt, 0); let r = Math.random() * tot; for (const k in RT) { r -= RT[k].wt; if (r <= 0) return k; } return 'w'; }
  spawnNode() {
    for (let k = 0; k < 30; k++) {
      const a = Math.random() * Math.PI * 2, r = rnd(4.5, 22.5);
      const x = Math.round(Math.cos(a) * r) + .5, z = Math.round(Math.sin(a) * r) + .5;
      if (this.nodes.some(n => dist(n.x, n.z, x, z) < 2.6)) continue;
      const type = this.weighted(), max = type === 'w' ? rnd(8, 13) | 0 : rnd(6, 10) | 0;
      this.nodes.push({ id: this.nid++, type, x, z, amt: max, max });
      return;
    }
  }
  removeNode(n) { const i = this.nodes.indexOf(n); if (i >= 0) this.nodes.splice(i, 1); }
  nearestMonster(x, z, range) { let best = null, bd = range; for (const m of this.monsters) { if (m.dead) continue; const d = dist(x, z, m.x, m.z); if (d < bd) { bd = d; best = m; } } return best; }
  nearestRival(a, range) { let best = null, bd = range; for (const o of this.agents) { if (o === a || o.dead) continue; const d = dist(a.x, a.z, o.x, o.z); if (d < bd) { bd = d; best = o; } } return best; }
  pickNode(a) {
    let best = null, bs = -1;
    for (const n of this.nodes) {
      if (n.amt <= 0) continue;
      const d = dist(a.x, a.z, n.x, n.z);
      const c = this.agents.filter(o => o !== a && o.node === n && !o.dead).length;
      const s = Math.pow(RT[n.type].val, a.greed) / (d + 5) * (c >= 2 ? .25 : c === 1 ? .7 : 1);
      if (s > bs) { bs = s; best = n; }
    }
    return best;
  }
  moveTo(e, x, z, stop, spd, dt) {
    const dx = x - e.x, dz = z - e.z, d = Math.hypot(dx, dz);
    if (d <= stop) return true;
    const s = Math.min(d - stop + .001, spd * dt);
    e.x += dx / d * s; e.z += dz / d * s;
    e.r = lerpAngle(e.r, Math.atan2(dx, dz), Math.min(1, dt * 12));
    e.moving = true;
    return false;
  }
  face(e, x, z) { e.r = lerpAngle(e.r, Math.atan2(x - e.x, z - e.z), .3); }
  placeBlock(a, type) {
    if (a.blocks.length >= BP.length) { a.vault += RT[type].val; return; }
    a.blocks.push(type);
    if (a.blocks.length === BP.length) this.feed(`🏰 ${a.name} completed a full fortress`);
  }

  /* ---------- combat ---------- */
  hurt(v, dmg, att) {
    if (v.dead) return;
    v.hp -= dmg;
    if (this.chest && this.chest.opener === v) this.chest.progress = Math.max(0, this.chest.progress - dmg * .006);
    if (v.hp > 0) return;
    v.hp = 0; v.dead = true; v.deadUntil = this.T + 6; v.state = 'dead'; v.node = null; v.foe = null;
    if (this.chest && this.chest.opener === v) { this.chest.opener = null; this.chest.progress = 0; }
    if (att && att.isAgent && !att.dead) {
      att.pvp++; att.foe = null;
      const room = Math.max(0, att.cap - att.carry.length);
      const taken = v.carry.slice(0, room);
      att.carry.push(...taken);
      this.emit('kill', { killer: att, victim: v, supplies: taken.length });
    } else {
      this.feed(`💀 ${v.name} was knocked out by a zombie${v.carry.length ? ` and dropped ${v.carry.length} supplies` : ''}`);
    }
    v.carry = [];
  }
  killMonster(m, killer) {
    if (m.dead) return;
    m.dead = true;
    if (killer && !killer.dead) { killer.kills++; this.pop(killer.x, killer.z, '+15 🧟'); }
  }

  /* ---------- loot chest ---------- */
  dropChest(lamports) {
    if (this.chest) { this.chest.value += lamports; this.feed(`🎁 More creator fees were added to the unopened chest`, 'loot'); this.emit('chestUpdate'); return; }
    const ang = Math.random() * Math.PI * 2, r = rnd(0, 12);
    this.chest = { x: Math.round(Math.cos(ang) * r) + .5, z: Math.round(Math.sin(ang) * r) + .5, value: lamports, opener: null, progress: 0 };
    this.emit('chestDrop', this.chest);
  }
  openChest(a) {
    const lamports = this.chest.value;
    a.chestPts += 100;
    this.chest = null;
    this.emit('chestOpen', { agent: a, lamports });
  }

  /* ---------- power-ups ---------- */
  applyPerk(i, perk) {
    const a = this.agents[i];
    let note = PERKS[perk].name;
    if (perk === 'boost') a.boostUntil = Math.max(this.T, a.boostUntil) + 20;
    if (perk === 'heal') { if (!a.dead) a.hp = a.maxhp; a.shieldUntil = this.T + 25; }
    if (perk === 'crate') for (let k = 0; k < 8; k++) a.crateQ.push(pick(['s', 's', 'i', 'i', 'w', 'g']));
    if (perk === 'sword') {
      if (a.sword < 4) { a.sword++; note = `a ${SWORD_NAME[a.sword]} sword`; }
      else { for (let k = 0; k < 10; k++) a.crateQ.push('g'); note = '10 gold blocks (sword already maxed)'; }
    }
    this.pop(a.x, a.z, `+◎${PERKS[perk].sol}`, 'sol');
    return note;
  }

  /* ---------- AI ---------- */
  updAgent(a, dt) {
    a.moving = false; a.swing = false;
    if (a.dead) {
      if (this.T >= a.deadUntil) { a.dead = false; a.hp = a.maxhp; a.x = a.ex; a.z = a.ez; a.state = 'seek'; }
      return;
    }
    const T = this.T, boosted = T < a.boostUntil, spd = a.speed * (boosted ? 1.7 : 1), low = a.hp < a.maxhp * .3, ch = this.chest;
    if (a.crateQ.length && T >= a.crateT) { this.placeBlock(a, a.crateQ.shift()); a.crateT = T + .12; }

    const threat = this.nearestMonster(a.x, a.z, 3 + a.brave * 5);
    if (threat) { if (low) { a.state = 'flee'; a.foe = null; } else { a.state = 'fight'; a.foe = threat; } }
    else if (ch && a.hp > a.maxhp * .35 && (a.greed >= 1 || dist(a.x, a.z, ch.x, ch.z) < 26)) {
      const dc = dist(a.x, a.z, ch.x, ch.z);
      const channeling = ch.opener === a && dc < 1.8;
      const rival = !channeling && dc < 8 ? this.nearestRival(a, 3.2) : null;
      if (rival) { a.state = 'fight'; a.foe = rival; a.raidUntil = T + 2; } else { a.state = 'loot'; a.foe = null; }
    }
    else if (a.foe && a.foe.isAgent && !a.foe.dead && T < a.raidUntil) { if (low) { a.state = 'flee'; a.foe = null; } else a.state = 'fight'; }
    else if (a.state === 'fight' || a.state === 'loot' || (a.state === 'flee' && a.hp > a.maxhp * .6)) { a.state = a.carry.length ? 'return' : 'seek'; a.foe = null; }

    if (!threat && !ch && a.state !== 'fight' && a.state !== 'flee' && Math.random() < a.aggro * dt * .5) {
      const r = this.nearestRival(a, 7);
      if (r && r.carry.length >= 1) {
        a.foe = r; a.raidUntil = T + 14; a.state = 'fight';
        if (r.state !== 'flee') { r.foe = a; r.raidUntil = T + 14; r.state = 'fight'; }
      }
    }

    switch (a.state) {
      case 'seek':
        if (!a.node || a.node.amt <= 0 || !this.nodes.includes(a.node)) a.node = this.pickNode(a);
        if (a.node) { if (this.moveTo(a, a.node.x, a.node.z, a.node.type === 'w' ? 1.35 : 1, spd, dt)) { a.state = 'mine'; a.mineT = 0; } }
        else if (a.carry.length) a.state = 'return';
        break;
      case 'mine': {
        const n = a.node;
        if (!n || n.amt <= 0 || !this.nodes.includes(n)) { a.state = 'seek'; break; }
        this.face(a, n.x, n.z); a.swing = true; a.mineT += dt * (boosted ? 1.5 : 1);
        if (a.mineT >= RT[n.type].time) {
          a.mineT = 0; n.amt--; a.carry.push(n.type);
          if (n.amt <= 0) this.removeNode(n);
          if (a.carry.length >= a.cap) a.state = 'return'; else if (n.amt <= 0) a.state = 'seek';
        }
        break;
      }
      case 'return':
        if (this.moveTo(a, a.ex, a.ez, .3, spd, dt)) { a.state = 'build'; a.buildT = 0; }
        break;
      case 'build':
        this.face(a, a.hx, a.hz); a.swing = true; a.buildT += dt;
        if (a.buildT >= .22) { a.buildT = 0; if (a.carry.length) this.placeBlock(a, a.carry.shift()); if (!a.carry.length) { a.state = 'seek'; a.node = null; } }
        break;
      case 'flee':
        if (this.moveTo(a, a.ex, a.ez, .3, spd * 1.1, dt)) {
          a.hp = Math.min(a.maxhp, a.hp + 14 * dt); a.buildT += dt;
          if (a.carry.length && a.buildT > .25) { a.buildT = 0; this.placeBlock(a, a.carry.shift()); }
        }
        break;
      case 'loot':
        if (!ch) { a.state = 'seek'; break; }
        if (this.moveTo(a, ch.x, ch.z, 1.2, spd, dt)) {
          this.face(a, ch.x, ch.z); a.swing = true;
          const op = ch.opener;
          if (op !== a && (!op || op.dead || dist(op.x, op.z, ch.x, ch.z) > 1.8)) { ch.opener = a; ch.progress = 0; }
          if (ch.opener === a) { ch.progress += dt / 5 * (boosted ? 1.3 : 1); if (ch.progress >= 1) this.openChest(a); }
        }
        break;
      case 'fight': {
        const f = a.foe;
        if (!f || f.dead) { a.state = 'seek'; a.foe = null; break; }
        if (this.moveTo(a, f.x, f.z, 1.05, spd, dt)) {
          this.face(a, f.x, f.z); a.swing = true;
          const dps = (10 + a.sword * 6) * (boosted ? 1.25 : 1);
          if (f.isAgent) this.hurt(f, dps * 1.1 * dt * (T < f.shieldUntil ? .4 : 1), a);
          else { f.hp -= dps * dt; f.lastHit = a; f.lastHitT = T; if (f.hp <= 0) this.killMonster(f, a); }
        }
        break;
      }
    }
    if (a.state !== 'fight') a.hp = Math.min(a.maxhp, a.hp + 1.5 * dt);
  }

  spawnMonster() {
    const ang = Math.random() * Math.PI * 2, max = 30 + this.round * 4;
    this.monsters.push({ id: this.mid++, x: Math.cos(ang) * 34, z: Math.sin(ang) * 34, r: 0, hp: max, max, speed: rnd(2.3, 3), atkT: 0, dead: false, house: null, lastHit: null, lastHitT: -9 });
  }
  updMonster(m, dt) {
    m.moving = false;
    if (this.phase === 'dawn' || this.phase === 'day') m.hp -= 14 * dt;
    if (m.hp <= 0) { this.killMonster(m, this.T - m.lastHitT < 1 ? m.lastHit : null); return; }
    let tgt = null, bd = 14;
    for (const a of this.agents) { if (a.dead) continue; const d = dist(m.x, m.z, a.x, a.z); if (d < bd) { bd = d; tgt = a; } }
    if (tgt) {
      if (this.moveTo(m, tgt.x, tgt.z, 1, m.speed, dt)) {
        this.face(m, tgt.x, tgt.z); m.atkT -= dt;
        if (m.atkT <= 0) { m.atkT = .8; this.hurt(tgt, (9 + this.round % 20) * (this.T < tgt.shieldUntil ? .4 : 1), null); }
      }
      return;
    }
    if (!m.house || !m.house.blocks.length) {
      let b = null, bd2 = 1e9;
      for (const a of this.agents) { if (!a.blocks.length) continue; const d = dist(m.x, m.z, a.hx, a.hz); if (d < bd2) { bd2 = d; b = a; } }
      m.house = b;
    }
    if (m.house) {
      if (this.moveTo(m, m.house.hx, m.house.hz, 2.9, m.speed, dt)) { this.face(m, m.house.hx, m.house.hz); m.atkT -= dt; if (m.atkT <= 0) { m.atkT = 2.2; m.house.blocks.pop(); } }
    } else this.moveTo(m, 0, 0, 2, m.speed * .6, dt);
  }

  /* ---------- rounds ---------- */
  endRound() {
    const ranked = [...this.agents].sort((a, b) => this.score(b) - this.score(a));
    this.winner = ranked[0]; this.winner.wins++;
    this.monsters = [];
    this.mode = 'results';
    this.resultsEnd = this.T + this.cfg.RESULTS_SECONDS;
    this.feed(`🏆 Round ${this.round}: ${this.winner.name} wins with ${this.score(this.winner)} points`);
    this.emit('roundEnd', { round: this.round, winner: this.winner, ranked });
  }
  startRound() {
    this.round++; this.t = 0; this.mode = 'race'; this.phase = 'day'; this.winner = null;
    this.nodes = [];
    for (let k = 0; k < NODE_MAX; k++) this.spawnNode();
    for (const a of this.agents) this.resetAgent(a);
    if (this.chest) { this.chest.opener = null; this.chest.progress = 0; }
    this.feed(`🔔 Round ${this.round} started. Investing is open for ${Math.round(this.cfg.INVEST_CLOSE / 60)} minutes.`);
    this.emit('roundStart', this.round);
  }

  step(dt) {
    this.T += dt;
    if (this.mode !== 'race') { if (this.T >= this.resultsEnd) this.startRound(); return; }
    if (this.T >= this.nextLoot) { this.nextLoot += this.cfg.LOOT_EVERY; this.emit('lootTime'); }
    const before = this.t;
    this.t += dt;
    const ph = this.phaseOf(this.t);
    if (ph !== this.phase) { this.phase = ph; if (ph === 'night') this.feed('🌙 Night fell. Zombies are spawning at the walls.'); }
    if (before < this.cfg.INVEST_CLOSE && this.t >= this.cfg.INVEST_CLOSE) this.feed('🔒 Investing is closed for this round.');
    if (this.nodes.length < NODE_MAX && this.T >= this.nextNodeSpawn) { this.spawnNode(); this.nextNodeSpawn = this.T + 1; }
    if (this.phase === 'night' && this.T >= this.nextMonster && this.monsters.length < 12 + Math.min(this.round, 10) * 2) {
      this.spawnMonster(); this.nextMonster = this.T + Math.max(1, 2.6 - Math.min(this.round, 10) * .12);
    }
    for (const a of this.agents) this.updAgent(a, dt);
    for (const m of this.monsters) if (!m.dead) this.updMonster(m, dt);
    this.monsters = this.monsters.filter(m => !m.dead);
    if (this.t >= this.cfg.ROUND_SECONDS) this.endRound();
  }

  /* ---------- network snapshots ---------- */
  tick() {
    const T = this.T;
    return {
      round: this.round, mode: this.mode, t: Math.round(this.t * 10) / 10,
      lootIn: Math.max(0, Math.ceil(this.nextLoot - T)), investOpen: this.investOpen(),
      resultsIn: this.mode === 'results' ? Math.max(0, Math.ceil(this.resultsEnd - T)) : 0,
      winner: this.winner ? this.winner.i : -1,
      agents: this.agents.map(a => [r2(a.x), r2(a.z), r2(a.r), STATES.indexOf(a.state), Math.ceil(a.hp), a.sword, a.swing ? 1 : 0,
        Math.max(0, Math.ceil(a.boostUntil - T)), Math.max(0, Math.ceil(a.shieldUntil - T)), a.carry.length]),
      monsters: this.monsters.map(m => [m.id, r2(m.x), r2(m.z), r2(m.r), r2(Math.max(0, m.hp / m.max))]),
      chest: this.chest && { x: this.chest.x, z: this.chest.z, v: this.chest.value, o: this.chest.opener ? this.chest.opener.i : -1, p: r2(this.chest.progress) },
    };
  }
  world() {
    return {
      nodes: this.nodes.map(n => [n.id, n.type, n.x, n.z, r2(n.amt / n.max)]),
      houses: this.agents.map(a => a.blocks.join('')),
      scores: this.agents.map(a => this.score(a)),
      pvp: this.agents.map(a => a.pvp),
      kills: this.agents.map(a => a.kills),
      wins: this.agents.map(a => a.wins),
    };
  }
}
