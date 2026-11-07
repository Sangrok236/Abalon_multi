"use strict";
// 실제 서버를 띄우고 WebSocket 클라이언트 5개로 한 판을 끝까지 진행
const test = require("node:test");
const assert = require("node:assert");
const { spawn } = require("child_process");
const path = require("path");
const WebSocket = require("ws");

const PORT = 3900 + Math.floor(Math.random() * 90);

function client(name) {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
  const c = { name, ws, state: null, token: null, code: null, waiters: [] };
  ws.on("message", raw => {
    const m = JSON.parse(raw);
    if (m.t === "joined") { c.token = m.token; c.code = m.code; }
    if (m.t === "state") c.state = m.state;
    if (m.t === "error") c.lastError = m.msg;
    c.waiters = c.waiters.filter(w => !w(c));
  });
  c.open = new Promise(r => ws.on("open", r));
  c.send = o => ws.send(JSON.stringify(o));
  c.until = pred => new Promise((res, rej) => {
    if (pred(c)) return res();
    const t = setTimeout(() => rej(new Error(`${name}: timeout`)), 3000);
    c.waiters.push(cc => { if (pred(cc)) { clearTimeout(t); res(); return true; } return false; });
  });
  return c;
}

test("full game over websockets", async t => {
  const srv = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], { env: { ...process.env, PORT } });
  t.after(() => srv.kill());
  await new Promise(r => srv.stdout.on("data", r));

  const host = client("방장");
  await host.open;
  host.send({ t: "create", name: "방장" });
  await host.until(c => c.state);
  const code = host.code;
  assert.match(code, /^\d{4}$/);

  const others = ["철수", "영희", "민수", "지영"].map(client);
  await Promise.all(others.map(c => c.open));
  for (const c of others) { c.send({ t: "join", code, name: c.name }); await c.until(x => x.state); }
  const all = [host, ...others];
  await host.until(c => c.state.players.length === 5);

  host.send({ t: "setVoteMode", secret: true });
  host.send({ t: "start" });
  await Promise.all(all.map(c => c.until(x => x.state.phase === "reveal")));

  // 각자 자기 역할만 받는다
  const roles = all.map(c => c.state.game.my.role);
  assert.equal(roles.filter(r => ["assassin", "minion"].includes(r)).length, 2);
  for (const c of all) assert.equal(c.state.game.roles, undefined);

  all.forEach(c => c.send({ t: "revealOk" }));
  await Promise.all(all.map(c => c.until(x => x.state.phase === "team")));

  // 재접속: 한 명 끊었다가 토큰으로 복귀
  const leaver = others[0];
  leaver.ws.close();
  await host.until(c => !c.state.players[1].connected);
  const back = client(leaver.name);
  await back.open;
  back.send({ t: "resume", code, token: leaver.token });
  await back.until(c => c.state && c.state.phase === "team");
  assert.equal(back.state.game.my.role, roles[1]);
  all[1] = back;
  await host.until(c => c.state.players[1].connected);

  // 원정 3번 성공 (모두 성공 카드)
  for (let q = 0; q < 3; q++) {
    const L = all[host.state.game.leader];
    const need = [2, 3, 2][q];
    for (let i = 0; i < need; i++) L.send({ t: "pick", i });
    L.send({ t: "propose" });
    await host.until(c => c.state.phase === "vote");
    all.forEach(c => c.send({ t: "vote", v: true }));
    await host.until(c => c.state.phase === "voteResult");
    assert.equal(host.state.game.lastVote.detail, null); // 비밀 투표
    L.send({ t: "next" });
    await host.until(c => c.state.phase === "quest");
    for (const i of host.state.game.team) all[i].send({ t: "quest", v: "s" });
    await host.until(c => c.state.phase === "questResult");
    L.send({ t: "next" });
    await host.until(c => c.state.phase === (q < 2 ? "team" : "assassin"));
  }

  const ai = roles.indexOf("assassin"), mi = roles.indexOf("merlin");
  all[ai].send({ t: "aim", i: mi });
  all[ai].send({ t: "kill" });
  await Promise.all(all.map(c => c.until(x => x.state.phase === "end")));
  assert.equal(host.state.game.winner, "e");
  assert.deepEqual(host.state.game.roles, roles);

  // 같은 멤버로 다시
  host.send({ t: "again" });
  await host.until(c => c.state.phase === "reveal");
  all.forEach(c => c.ws.close());
});
