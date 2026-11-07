"use strict";
// 게임 규칙과 방 상태. 네트워크와 무관한 순수 로직 (테스트하기 쉽게 분리).

const crypto = require("crypto");

// ---------- 규칙 데이터 (오프라인 버전과 동일) ----------
const TEAM_SIZES = {
  5: [2, 3, 2, 3, 3], 6: [2, 3, 4, 3, 4], 7: [2, 3, 3, 4, 4],
  8: [3, 4, 4, 5, 5], 9: [3, 4, 4, 5, 5], 10: [3, 4, 4, 5, 5]
};
const EVIL_COUNT = { 5: 2, 6: 2, 7: 3, 8: 3, 9: 3, 10: 4 };
const TEAM_OF = {
  merlin: "g", percival: "g", servant: "g",
  assassin: "e", morgana: "e", mordred: "e", oberon: "e", minion: "e"
};
const OPT_KEYS = ["percival", "morgana", "mordred", "oberon"];
// 인원별 추천 조합 (클라이언트 표시용 데이터와 같음)
const P = (percival, morgana, mordred, oberon) => ({ percival, morgana, mordred, oberon });
const RECOMMEND_OPTS = {
  5: [P(0, 0, 0, 0)],
  6: [P(1, 1, 0, 0), P(1, 0, 1, 0)],
  7: [P(0, 0, 0, 0), P(1, 1, 0, 1), P(1, 1, 0, 0), P(1, 1, 1, 0)],
  8: [P(0, 0, 0, 0), P(1, 1, 0, 1), P(1, 1, 0, 0), P(1, 1, 1, 0)],
  9: [P(1, 1, 1, 0)],
  10: [P(1, 1, 1, 1), P(1, 1, 1, 0)]
};
const sameOpts = (a, b) => OPT_KEYS.every(k => !!a[k] === !!b[k]);
const MIN_PLAYERS = 5, MAX_PLAYERS = 10;

const shuffle = a => {
  a = a.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

function buildRoles(count, opts) {
  const evilN = EVIL_COUNT[count];
  const evil = ["assassin"];
  if (opts.morgana) evil.push("morgana");
  if (opts.mordred) evil.push("mordred");
  if (opts.oberon) evil.push("oberon");
  if (evil.length > evilN) return { error: `${count}명은 악이 ${evilN}명이라 특수 악 역할을 ${evilN - 1}개까지만 고를 수 있어요.` };
  while (evil.length < evilN) evil.push("minion");
  const good = ["merlin"];
  if (opts.percival) good.push("percival");
  while (good.length < count - evilN) good.push("servant");
  return { roles: shuffle(good.concat(evil)) };
}

// 플레이어 i가 볼 수 있는 정보. 이름만 담고, 역할은 절대 담지 않는다.
function infoFor(players, i) {
  const me = players[i].role;
  const others = players.map((p, j) => ({ ...p, j })).filter(p => p.j !== i);
  const names = arr => arr.map(p => p.name);
  const has = r => players.some(p => p.role === r);
  if (me === "merlin") {
    const seen = others.filter(p => TEAM_OF[p.role] === "e" && p.role !== "mordred");
    return { label: "악의 세력", names: names(seen), notes: has("mordred") ? ["모드레드는 보이지 않습니다."] : [] };
  }
  if (me === "percival") {
    const seen = shuffle(others.filter(p => p.role === "merlin" || p.role === "morgana"));
    return seen.length > 1
      ? { label: "멀린 후보", names: names(seen), notes: ["둘 중 한 명은 모르가나입니다."] }
      : { label: "멀린", names: names(seen), notes: [] };
  }
  if (me === "oberon") return { label: null, names: [], notes: ["당신은 동료를 모릅니다."] };
  if (TEAM_OF[me] === "e") {
    const seen = others.filter(p => TEAM_OF[p.role] === "e" && p.role !== "oberon");
    return { label: "동료 악", names: names(seen), notes: has("oberon") ? ["오베론은 따로 숨어 있습니다."] : [] };
  }
  return { label: null, names: [], notes: ["정보 없음. 추리로 승부하세요!"] };
}

class GameError extends Error {}
const fail = msg => { throw new GameError(msg); };
const newId = () => crypto.randomBytes(6).toString("hex");
const newToken = () => crypto.randomBytes(18).toString("base64url");

function cleanName(name) {
  const n = String(name || "").replace(/\s+/g, " ").trim().slice(0, 10);
  if (!n) fail("이름을 입력해 주세요.");
  return n;
}

class Room {
  constructor(code) {
    this.code = code;
    this.players = []; // 앉은 순서 = 배열 순서
    this.hostId = null;
    this.opts = { percival: 0, morgana: 0, mordred: 0, oberon: 0 };
    this.autoOpts = true; // 방장이 직접 토글하기 전까지는 인원에 맞는 추천 조합을 자동 적용
    this.secretVote = false;
    this.phase = "lobby";
    this.g = null;
    this.lastActive = Date.now();
  }

  // ----- 입장/퇴장 -----
  addPlayer(name) {
    name = cleanName(name);
    const existing = this.players.find(p => p.name === name);
    if (this.phase !== "lobby") {
      // 게임 중에는 연결이 끊긴 사람의 자리를 같은 이름으로 이어받기만 허용
      if (existing && !existing.connected) { existing.token = newToken(); return existing; }
      if (existing) fail(`"${name}"님은 이미 접속해 있어요.`);
      fail("이미 게임이 진행 중이에요. 원래 이름으로 들어오면 자기 자리로 돌아갈 수 있어요.");
    }
    if (existing) fail(`이름 "${name}"은(는) 이미 있어요.`);
    if (this.players.length >= MAX_PLAYERS) fail(`최대 ${MAX_PLAYERS}명까지예요.`);
    const p = { id: newId(), token: newToken(), name, connected: false, role: null };
    this.players.push(p);
    if (!this.hostId) this.hostId = p.id;
    this.syncOpts();
    return p;
  }
  byToken(token) { return this.players.find(p => p.token === token); }
  byId(id) { return this.players.find(p => p.id === id); }
  idx(p) { return this.players.indexOf(p); }

  removePlayer(id) {
    const i = this.players.findIndex(p => p.id === id);
    if (i < 0) return;
    this.players.splice(i, 1);
    if (this.hostId === id) this.pickNewHost();
    this.syncOpts();
  }
  syncOpts() {
    const recs = RECOMMEND_OPTS[this.players.length];
    if (!this.autoOpts || !recs || recs.some(r => sameOpts(r, this.opts))) return;
    this.opts = { ...recs[0] };
  }
  pickNewHost() {
    const next = this.players.find(p => p.connected) || this.players[0];
    this.hostId = next ? next.id : null;
  }

  // ----- 액션 처리 -----
  act(p, msg) {
    this.lastActive = Date.now();
    const isHost = p.id === this.hostId;
    const host = () => { if (!isHost) fail("방장만 할 수 있어요."); };
    const phase = (...ph) => { if (!ph.includes(this.phase)) fail("지금은 할 수 없는 동작이에요."); };
    const g = this.g;
    const me = this.idx(p);

    switch (msg.t) {
      case "leave":
        if (this.phase !== "lobby") fail("게임 중에는 나갈 수 없어요. 방장이 로비로 돌아간 뒤 나가세요.");
        this.removePlayer(p.id);
        return;
      case "rename": {
        phase("lobby");
        const n = cleanName(msg.name);
        if (this.players.some(o => o !== p && o.name === n)) fail(`이름 "${n}"은(는) 이미 있어요.`);
        p.name = n;
        return;
      }
      case "setOpts":
        host(); phase("lobby");
        OPT_KEYS.forEach(k => { this.opts[k] = msg.opts && msg.opts[k] ? 1 : 0; });
        this.autoOpts = !!msg.preset;
        return;
      case "setVoteMode":
        host(); phase("lobby");
        this.secretVote = !!msg.secret;
        return;
      case "kick": {
        host(); phase("lobby");
        if (msg.id === p.id) fail("자기 자신은 내보낼 수 없어요.");
        this.removePlayer(msg.id);
        return;
      }
      case "move": {
        host(); phase("lobby");
        const i = this.players.findIndex(o => o.id === msg.id), j = i + (msg.d > 0 ? 1 : -1);
        if (i < 0 || j < 0 || j >= this.players.length) return;
        [this.players[i], this.players[j]] = [this.players[j], this.players[i]];
        return;
      }
      case "makeHost": {
        host();
        if (!this.byId(msg.id)) fail("없는 플레이어예요.");
        this.hostId = msg.id;
        return;
      }
      case "start":
        host(); phase("lobby");
        this.start();
        return;
      case "again":
        host(); phase("end");
        this.start();
        return;
      case "toLobby":
        host();
        this.phase = "lobby"; this.g = null;
        this.players.forEach(o => { o.role = null; });
        return;

      case "revealOk":
        phase("reveal");
        g.revealed[me] = true;
        if (g.revealed.every(Boolean)) {
          g.log.push(`첫 대표: ${this.players[g.leader].name}`);
          this.phase = "team";
        }
        return;

      case "pick": {
        phase("team");
        if (me !== g.leader) fail("대표만 원정대를 고를 수 있어요.");
        const i = msg.i | 0, need = this.need();
        if (i < 0 || i >= this.players.length) return;
        if (g.team.includes(i)) g.team = g.team.filter(x => x !== i);
        else if (g.team.length < need) g.team.push(i);
        return;
      }
      case "propose":
        phase("team");
        if (me !== g.leader) fail("대표만 제안할 수 있어요.");
        if (g.team.length !== this.need()) fail(`원정대 ${this.need()}명을 골라 주세요.`);
        g.team.sort((a, b) => a - b);
        g.votes = Array(this.players.length).fill(null);
        this.phase = "vote";
        return;
      case "cancelProposal":
        phase("vote");
        if (me !== g.leader) fail("대표만 취소할 수 있어요.");
        if (g.votes.some(v => v !== null)) fail("이미 누군가 투표해서 취소할 수 없어요.");
        this.phase = "team";
        return;
      case "vote": {
        phase("vote");
        g.votes[me] = !!msg.v;
        if (g.votes.some(v => v === null)) return;
        const yes = g.votes.filter(v => v).length, no = g.votes.length - yes, pass = yes > no;
        g.lastVote = {
          yes, no, pass, team: g.team.slice(), leader: g.leader,
          detail: this.secretVote ? null : g.votes.slice()
        };
        const names = g.team.map(i => this.players[i].name).join(", ");
        g.log.push(`${g.questIdx + 1}원정 · 👑${this.players[g.leader].name} 제안 [${names}] → ${pass ? "가결" : "부결"} (찬${yes}:반${no})`);
        if (pass) {
          g.questVotes = Array(this.players.length).fill(null);
        } else {
          g.rejects++;
          if (g.rejects >= 5) return this.end("e", "원정대가 5번 연속 부결되었습니다.");
        }
        this.phase = "voteResult";
        return;
      }
      case "next":
        phase("voteResult", "questResult");
        if (!isHost && me !== g.leader) fail("대표나 방장이 넘길 수 있어요.");
        if (this.phase === "voteResult") {
          if (g.lastVote.pass) { this.phase = "quest"; }
          else { this.nextLeader(); g.team = []; this.phase = "team"; }
        } else {
          const s = g.quests.filter(q => q && q.result === "s").length;
          const f = g.quests.filter(q => q && q.result === "f").length;
          if (f >= 3) return this.end("e", "원정이 3번 실패했습니다.");
          if (s >= 3) { g.assassinTarget = null; this.phase = "assassin"; return; }
          g.questIdx++; g.rejects = 0; this.nextLeader(); g.team = [];
          this.phase = "team";
        }
        return;
      case "quest": {
        phase("quest");
        if (!g.team.includes(me)) fail("원정대원만 카드를 낼 수 있어요.");
        if (g.questVotes[me] !== null) fail("이미 카드를 냈어요.");
        const v = msg.v === "f" ? "f" : "s";
        if (v === "f" && TEAM_OF[p.role] === "g") fail("선의 세력은 성공만 낼 수 있어요.");
        g.questVotes[me] = v;
        if (g.team.some(i => g.questVotes[i] === null)) return;
        const cards = g.team.map(i => g.questVotes[i]);
        const fails = cards.filter(c => c === "f").length;
        const needFails = (g.questIdx === 3 && this.players.length >= 7) ? 2 : 1;
        const result = fails >= needFails ? "f" : "s";
        g.quests[g.questIdx] = { team: g.team.slice(), fails, result };
        g.lastQuest = { idx: g.questIdx, cards: shuffle(cards), fails, result };
        g.questVotes = null;
        g.log.push(`→ ${g.questIdx + 1}원정 ${result === "s" ? "성공" : "실패"} (실패 ${fails}장)`);
        this.phase = "questResult";
        return;
      }
      case "aim":
        phase("assassin");
        if (p.role !== "assassin") fail("암살자만 지목할 수 있어요.");
        if (msg.i === me || !this.players[msg.i]) return;
        g.assassinTarget = msg.i | 0;
        return;
      case "kill": {
        phase("assassin");
        if (p.role !== "assassin") fail("암살자만 암살할 수 있어요.");
        const t = this.players[g.assassinTarget];
        if (!t) fail("먼저 대상을 골라 주세요.");
        const merlin = this.players.find(o => o.role === "merlin");
        if (t.role === "merlin") this.end("e", `암살자가 멀린(${t.name})을 찾아냈습니다!`);
        else this.end("g", `암살자가 ${t.name}님을 지목했지만, 멀린은 ${merlin.name}님이었습니다!`);
        return;
      }
      default:
        fail("알 수 없는 요청이에요.");
    }
  }

  need() { return TEAM_SIZES[this.players.length][this.g.questIdx]; }
  nextLeader() { this.g.leader = (this.g.leader + 1) % this.players.length; }
  end(w, reason) { this.g.winner = w; this.g.reason = reason; this.phase = "end"; }

  start() {
    const n = this.players.length;
    if (n < MIN_PLAYERS) fail(`최소 ${MIN_PLAYERS}명이 필요해요. (지금 ${n}명)`);
    if (n > MAX_PLAYERS) fail(`최대 ${MAX_PLAYERS}명까지예요.`);
    const r = buildRoles(n, this.opts);
    if (r.error) fail(r.error);
    this.players.forEach((p, i) => { p.role = r.roles[i]; });
    // 시야 정보는 시작할 때 한 번 계산해서 고정 (퍼시벌 후보 순서가 매번 바뀌지 않도록)
    this.players.forEach((p, i) => { p.info = infoFor(this.players, i); });
    this.g = {
      revealed: Array(n).fill(false),
      quests: [null, null, null, null, null],
      questIdx: 0, leader: crypto.randomInt(n), rejects: 0,
      team: [], votes: null, lastVote: null, questVotes: null, lastQuest: null,
      log: [], winner: null, reason: null, assassinTarget: null,
      secretVote: this.secretVote
    };
    this.phase = "reveal";
  }

  // ----- 플레이어별 화면 상태 (비밀 정보는 본인 것만) -----
  viewFor(p) {
    const base = {
      code: this.code, phase: this.phase, hostId: this.hostId,
      me: { id: p.id, name: p.name },
      players: this.players.map(o => ({ id: o.id, name: o.name, connected: o.connected })),
      opts: this.opts, secretVote: this.secretVote,
      teamSizes: TEAM_SIZES, evilCount: EVIL_COUNT
    };
    const g = this.g;
    if (!g) return base;
    const me = this.idx(p);
    const roleCounts = {};
    this.players.forEach(o => { roleCounts[o.role] = (roleCounts[o.role] || 0) + 1; });
    const game = {
      count: this.players.length,
      quests: g.quests.map(q => q && { result: q.result, fails: q.fails, team: q.team }),
      questIdx: g.questIdx, leader: g.leader, rejects: g.rejects, team: g.team,
      secretVote: g.secretVote,
      roleCounts,
      revealed: g.revealed,
      voted: g.votes ? g.votes.map(v => v !== null) : null,
      lastVote: g.lastVote,
      questDone: g.questVotes ? g.team.map(i => g.questVotes[i] !== null) : null,
      lastQuest: g.lastQuest,
      log: g.log,
      my: {
        idx: me, role: p.role, info: p.info,
        vote: g.votes ? g.votes[me] : null,
        questVote: g.questVotes ? g.questVotes[me] : null
      }
    };
    if (this.phase === "assassin" || this.phase === "end") {
      game.assassin = this.players.findIndex(o => o.role === "assassin");
      game.assassinTarget = g.assassinTarget;
    }
    if (this.phase === "end") {
      game.winner = g.winner; game.reason = g.reason;
      game.roles = this.players.map(o => o.role);
    }
    base.game = game;
    return base;
  }
}

module.exports = { Room, GameError, TEAM_SIZES, EVIL_COUNT, buildRoles, infoFor, MIN_PLAYERS, MAX_PLAYERS };
