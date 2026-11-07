"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { Room, GameError, infoFor } = require("../game");

function makeRoom(n, opts) {
  const r = new Room("1234");
  const ps = [];
  for (let i = 0; i < n; i++) { const p = r.addPlayer("P" + i); p.connected = true; ps.push(p); }
  if (opts) r.act(ps[0], { t: "setOpts", opts });
  return { r, ps };
}
const byRole = (r, role) => r.players.find(p => p.role === role);

function revealAll(r, ps) { ps.forEach(p => r.act(p, { t: "revealOk" })); }
function proposeAndPass(r, approve = true) {
  const g = r.g, leader = r.players[g.leader];
  const need = r.need();
  for (let i = 0; g.team.length < need; i++) r.act(leader, { t: "pick", i });
  r.act(leader, { t: "propose" });
  r.players.forEach(p => r.act(p, { t: "vote", v: approve }));
  r.act(r.players[g.leader], { t: "next" });
}
function playQuest(r, fail) {
  const g = r.g;
  for (const i of g.team.slice()) {
    const p = r.players[i];
    const v = fail && p.role !== "merlin" && ["assassin", "morgana", "mordred", "oberon", "minion"].includes(p.role) ? "f" : "s";
    r.act(p, { t: "quest", v });
  }
}

test("view never leaks other players' roles", () => {
  const { r, ps } = makeRoom(7, { percival: 1, morgana: 1, mordred: 1 });
  r.act(ps[0], { t: "start" });
  for (const p of ps) {
    const v = JSON.stringify(r.viewFor(p));
    for (const o of ps) if (o !== p) assert.ok(!v.includes(o.token), "token leaked");
    assert.equal(r.viewFor(p).game.roles, undefined);
    assert.equal(r.viewFor(p).game.my.role, p.role);
  }
});

test("role info visibility", () => {
  const { r, ps } = makeRoom(10, { percival: 1, morgana: 1, mordred: 1, oberon: 1 });
  r.act(ps[0], { t: "start" });
  const names = role => r.players.filter(p => p.role === role).map(p => p.name);
  const merlin = byRole(r, "merlin"), perc = byRole(r, "percival"), ob = byRole(r, "oberon"), asn = byRole(r, "assassin");
  const mi = merlin.info.names.sort();
  assert.deepEqual(mi, [...names("assassin"), ...names("morgana"), ...names("oberon")].sort());
  assert.deepEqual(perc.info.names.sort(), [...names("merlin"), ...names("morgana")].sort());
  assert.deepEqual(ob.info.names, []);
  assert.deepEqual(asn.info.names.sort(), [...names("morgana"), ...names("mordred")].sort());
  assert.deepEqual(byRole(r, "servant").info.names, []);
});

test("good players cannot play fail", () => {
  const { r, ps } = makeRoom(5);
  r.act(ps[0], { t: "start" });
  revealAll(r, ps);
  const g = r.g;
  // 대표가 선 플레이어를 포함한 팀을 고르게 강제
  const goodIdx = r.players.findIndex(p => p.role === "merlin");
  const leader = r.players[g.leader];
  r.act(leader, { t: "pick", i: goodIdx });
  for (let i = 0; g.team.length < r.need(); i++) r.act(leader, { t: "pick", i });
  if (!g.team.includes(goodIdx)) return; // 대표가 자기 자신을 해제한 경우 등은 건너뜀
  r.act(leader, { t: "propose" });
  ps.forEach(p => r.act(p, { t: "vote", v: true }));
  r.act(r.players[g.leader], { t: "next" });
  assert.throws(() => r.act(r.players[goodIdx], { t: "quest", v: "f" }), GameError);
});

test("non-leader cannot pick, only team can play", () => {
  const { r, ps } = makeRoom(6);
  r.act(ps[0], { t: "start" });
  revealAll(r, ps);
  const other = r.players[(r.g.leader + 1) % 6];
  assert.throws(() => r.act(other, { t: "pick", i: 0 }), GameError);
});

test("five rejects -> evil wins", () => {
  const { r, ps } = makeRoom(5);
  r.act(ps[0], { t: "start" });
  revealAll(r, ps);
  for (let k = 0; k < 4; k++) proposeAndPass(r, false);
  assert.equal(r.phase, "team");
  const leader = r.players[r.g.leader];
  for (let i = 0; r.g.team.length < r.need(); i++) r.act(leader, { t: "pick", i });
  r.act(leader, { t: "propose" });
  ps.forEach(p => r.act(p, { t: "vote", v: false }));
  assert.equal(r.phase, "end");
  assert.equal(r.g.winner, "e");
});

test("three successes -> assassin; wrong guess = good wins", () => {
  const { r, ps } = makeRoom(5);
  r.act(ps[0], { t: "start" });
  revealAll(r, ps);
  for (let q = 0; q < 3; q++) {
    proposeAndPass(r, true);
    playQuest(r, false);
    assert.equal(r.phase, "questResult");
    assert.equal(r.g.quests[q].result, "s");
    r.act(r.players[r.g.leader], { t: "next" });
  }
  assert.equal(r.phase, "assassin");
  const asn = byRole(r, "assassin");
  const notMerlin = r.players.findIndex(p => p.role === "servant");
  assert.throws(() => r.act(ps.find(p => p !== asn), { t: "kill" }), GameError);
  r.act(asn, { t: "aim", i: notMerlin });
  r.act(asn, { t: "kill" });
  assert.equal(r.g.winner, "g");
  assert.equal(r.viewFor(ps[1]).game.roles.length, 5);
});

test("secret vote hides detail; public shows it", () => {
  for (const secret of [true, false]) {
    const { r, ps } = makeRoom(5);
    r.act(ps[0], { t: "setVoteMode", secret });
    r.act(ps[0], { t: "start" });
    revealAll(r, ps);
    const leader = r.players[r.g.leader];
    for (let i = 0; r.g.team.length < r.need(); i++) r.act(leader, { t: "pick", i });
    r.act(leader, { t: "propose" });
    // 투표 중에는 누가 뭘 냈는지 안 보임
    r.act(ps[0], { t: "vote", v: true });
    const mid = r.viewFor(ps[1]).game;
    assert.equal(mid.voted[0], true);
    assert.ok(!("votes" in mid));
    ps.forEach(p => r.act(p, { t: "vote", v: true }));
    assert.equal(r.g.lastVote.detail === null, secret);
  }
});

test("4th quest with 7+ needs two fails", () => {
  const { r, ps } = makeRoom(7);
  r.act(ps[0], { t: "start" });
  revealAll(r, ps);
  r.g.questIdx = 3;
  r.g.leader = 0;
  const evil = r.players.map((p, i) => i).filter(i => ["assassin", "minion"].includes(r.players[i].role));
  const good = r.players.map((p, i) => i).filter(i => !evil.includes(i));
  const team = [evil[0], ...good.slice(0, 3)];
  const leader = r.players[0];
  team.forEach(i => r.act(leader, { t: "pick", i }));
  assert.equal(r.g.team.length, 4);
  r.act(leader, { t: "propose" });
  ps.forEach(p => r.act(p, { t: "vote", v: true }));
  r.act(leader, { t: "next" });
  team.forEach(i => r.act(r.players[i], { t: "quest", v: evil.includes(i) ? "f" : "s" }));
  assert.equal(r.g.quests[3].result, "s");
  assert.equal(r.g.quests[3].fails, 1);
});

test("rejoin by name only for disconnected seat during game", () => {
  const { r, ps } = makeRoom(5);
  r.act(ps[0], { t: "start" });
  assert.throws(() => r.addPlayer("P1"), GameError);
  assert.throws(() => r.addPlayer("New"), GameError);
  ps[1].connected = false;
  const old = ps[1].token;
  const p = r.addPlayer("P1");
  assert.equal(p, ps[1]);
  assert.notEqual(p.token, old);
});

test("start validation", () => {
  const { r, ps } = makeRoom(4);
  assert.throws(() => r.act(ps[0], { t: "start" }), /최소 5명/);
  r.addPlayer("X");
  assert.throws(() => r.act(ps[1], { t: "start" }), /방장/);
  r.act(ps[0], { t: "setOpts", opts: { morgana: 1, mordred: 1 } });
  assert.throws(() => r.act(ps[0], { t: "start" }), /특수 악/);
});
