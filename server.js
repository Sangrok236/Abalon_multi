"use strict";
// HTTP(정적 파일) + WebSocket 서버. 게임 상태는 서버 메모리에만 있다.

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");
const QRCode = require("qrcode");
const { Room, GameError } = require("./game");

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, "public");
const ROOM_TTL = 3 * 60 * 60 * 1000;   // 아무도 없고 3시간 지난 방은 삭제
const HOST_AWAY = 2 * 60 * 1000;      // 방장이 2분 넘게 끊겨 있으면 방장 넘김

const rooms = new Map();
const sockets = new Map(); // playerId -> ws

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json" };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/healthz") { res.writeHead(200); res.end("ok"); return; }
  if (url.pathname === "/qr.svg") {
    const text = (url.searchParams.get("u") || "").slice(0, 300);
    QRCode.toString(text, { type: "svg", margin: 1 }, (err, svg) => {
      if (err) { res.writeHead(400); res.end(); return; }
      res.writeHead(200, { "Content-Type": TYPES[".svg"], "Cache-Control": "public, max-age=86400" }); res.end(svg);
    });
    return;
  }
  let file = path.normalize(path.join(PUBLIC, url.pathname === "/" ? "index.html" : url.pathname));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { // 모르는 경로는 index.html로 (예: /1234 같은 링크)
      fs.readFile(path.join(PUBLIC, "index.html"), (e2, d2) => {
        if (e2) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { "Content-Type": TYPES[".html"], "Cache-Control": "no-cache" }); res.end(d2);
      });
      return;
    }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(data);
  });
});

function newCode() {
  for (let tries = 0; tries < 1000; tries++) {
    const c = String(crypto.randomInt(1000, 10000));
    if (!rooms.has(c)) return c;
  }
  throw new Error("no free room code");
}

function send(ws, obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }

function broadcast(room) {
  for (const p of room.players) {
    const ws = sockets.get(p.id);
    if (ws && ws.roomCode === room.code) send(ws, { t: "state", state: room.viewFor(p) });
  }
}

function bind(ws, room, p) {
  const old = sockets.get(p.id);
  if (old && old !== ws) { send(old, { t: "replaced" }); old.playerId = null; old.close(); }
  ws.roomCode = room.code; ws.playerId = p.id;
  sockets.set(p.id, ws);
  p.connected = true; p.awaySince = null;
  send(ws, { t: "joined", code: room.code, token: p.token });
}

const wss = new WebSocketServer({ server, maxPayload: 4096 });

wss.on("connection", ws => {
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

  ws.on("message", raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.t !== "string") return;
    try {
      handle(ws, msg);
    } catch (e) {
      if (e instanceof GameError) send(ws, { t: "error", msg: e.message });
      else { console.error(e); send(ws, { t: "error", msg: "서버 오류가 났어요." }); }
    }
  });

  ws.on("close", () => {
    if (!ws.playerId) return;
    const room = rooms.get(ws.roomCode);
    if (sockets.get(ws.playerId) === ws) sockets.delete(ws.playerId);
    if (!room) return;
    const p = room.byId(ws.playerId);
    if (p) { p.connected = false; p.awaySince = Date.now(); }
    broadcast(room);
  });
});

function handle(ws, msg) {
  if (msg.t === "create") {
    const room = new Room(newCode());
    const p = room.addPlayer(msg.name);
    rooms.set(room.code, room);
    bind(ws, room, p);
    broadcast(room);
    return;
  }
  if (msg.t === "join") {
    const room = rooms.get(String(msg.code || "").trim());
    if (!room) throw new GameError("그런 방이 없어요. 방 코드를 확인해 주세요.");
    const p = room.addPlayer(msg.name);
    bind(ws, room, p);
    room.lastActive = Date.now();
    broadcast(room);
    return;
  }
  if (msg.t === "resume") {
    const room = rooms.get(String(msg.code || ""));
    const p = room && room.byToken(msg.token);
    if (!p) { send(ws, { t: "gone" }); return; }
    bind(ws, room, p);
    broadcast(room);
    return;
  }

  const room = rooms.get(ws.roomCode);
  const p = room && room.byId(ws.playerId);
  if (!p) { send(ws, { t: "gone" }); return; }
  const before = new Set(room.players.map(o => o.id));
  room.act(p, msg);
  // 나가거나 내보내진 사람에게 알림
  for (const id of before) {
    if (!room.byId(id)) {
      const s = sockets.get(id);
      sockets.delete(id);
      if (s) { send(s, { t: "kicked", reason: id === p.id ? null : "방장이 방에서 내보냈어요." }); s.playerId = null; }
    }
  }
  if (!room.players.length) { rooms.delete(room.code); return; }
  broadcast(room);
}

// 끊긴 연결 감지 + 방 정리
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false; ws.ping();
  }
  const now = Date.now();
  for (const [code, room] of rooms) {
    const anyone = room.players.some(p => p.connected);
    if (!anyone && now - room.lastActive > ROOM_TTL) { rooms.delete(code); continue; }
    const host = room.byId(room.hostId);
    if (host && !host.connected && host.awaySince && now - host.awaySince > HOST_AWAY && anyone) {
      room.pickNewHost();
      broadcast(room);
    }
    if (anyone) room.lastActive = now;
  }
}, 15000);

server.listen(PORT, () => console.log(`원탁 서버: http://localhost:${PORT}`));
