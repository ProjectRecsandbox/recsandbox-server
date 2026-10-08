// RecSandbox relay server.
// Players connect here (wss://...). It makes rooms with 6-digit codes and passes
// poses and player info between the people in a room. It stores nothing.

const http = require("http");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8080;
const MAX_PLAYERS = 8;
const MAX_MESSAGE_BYTES = 4096;
const MAX_MESSAGES_PER_SECOND = 60;

const rooms = new Map(); // code -> { players: Map(id -> { ws, name, look, place }) }
let nextId = 1;

// A tiny web page so hosting sites (and keep-awake pingers) can check the server is up.
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("RecSandbox relay is running. Rooms open: " + rooms.size + "\n");
});
const wss = new WebSocketServer({ server, maxPayload: MAX_MESSAGE_BYTES });

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function clean(value, max) {
  return String(value === undefined || value === null ? "" : value).slice(0, max);
}

// Only keep the look fields we know about, as short strings.
function cleanLook(look) {
  const out = {};
  for (const key of ["skin", "shirt", "pants", "hat", "badge"]) {
    out[key] = look && typeof look === "object" ? clean(look[key], 16) : "";
  }
  return out;
}

function isPose(a) {
  return Array.isArray(a) && a.length === 12 && a.every((n) => typeof n === "number" && Number.isFinite(n));
}

function newCode() {
  for (;;) {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    if (!rooms.has(code)) return code;
  }
}

function rosterOf(room) {
  const roster = {};
  for (const [id, p] of room.players) roster[id] = { name: p.name, look: p.look, place: p.place };
  return roster;
}

function broadcastRoster(room) {
  const msg = { t: "roster", players: rosterOf(room) };
  for (const p of room.players.values()) send(p.ws, msg);
}

wss.on("connection", (ws) => {
  ws.meta = null; // { code, id } once they are in a room
  let windowStart = Date.now();
  let count = 0;

  ws.on("message", (data) => {
    // Slow down anyone sending too much
    const now = Date.now();
    if (now - windowStart > 1000) { windowStart = now; count = 0; }
    if (++count > MAX_MESSAGES_PER_SECOND) return;

    let m;
    try { m = JSON.parse(data.toString()); } catch (e) { return; }
    if (!m || typeof m !== "object") return;

    // Not in a room yet: they must create or join one
    if (!ws.meta) {
      if (m.t !== "create" && m.t !== "join") return;
      let code;
      if (m.t === "create") {
        code = newCode();
        rooms.set(code, { players: new Map() });
      } else {
        code = clean(m.room, 6);
        if (!rooms.has(code)) {
          // "rejoin" lets a player come back after the server restarted: the room is made again
          if (m.rejoin === true && /^[0-9]{6}$/.test(code)) rooms.set(code, { players: new Map() });
          else return send(ws, { t: "error", msg: "There's no room with that code." });
        }
      }
      const room = rooms.get(code);
      if (room.players.size >= MAX_PLAYERS) return send(ws, { t: "error", msg: "That room is full." });
      const id = nextId++;
      room.players.set(id, {
        ws,
        name: clean(m.name, 20) || "Player",
        look: cleanLook(m.look),
        place: clean(m.place, 20),
      });
      ws.meta = { code, id };
      send(ws, { t: "welcome", id, room: code, host: m.t === "create" });
      broadcastRoster(room);
      return;
    }

    const room = rooms.get(ws.meta.code);
    if (!room) return;
    const me = room.players.get(ws.meta.id);
    if (!me) return;

    if (m.t === "info") {
      me.name = clean(m.name, 20) || me.name;
      me.look = cleanLook(m.look);
      me.place = clean(m.place, 20);
      broadcastRoster(room);
    } else if (m.t === "pose") {
      if (!isPose(m.h) || !isPose(m.l) || !isPose(m.r)) return;
      me.place = clean(m.place, 20) || me.place;
      const out = { t: "pose", id: ws.meta.id, place: me.place, h: m.h, l: m.l, r: m.r };
      for (const [id, p] of room.players) if (id !== ws.meta.id) send(p.ws, out);
    } else if (m.t === "ping") {
      send(ws, { t: "pong" });
    }
  });

  ws.on("close", () => {
    if (!ws.meta) return;
    const room = rooms.get(ws.meta.code);
    if (!room) return;
    room.players.delete(ws.meta.id);
    if (room.players.size === 0) rooms.delete(ws.meta.code);
    else broadcastRoster(room);
  });

  ws.on("error", () => {});
});

server.listen(PORT, () => console.log("RecSandbox relay listening on port " + PORT));
