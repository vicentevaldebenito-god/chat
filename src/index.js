import { DurableObject } from "cloudflare:workers";

export class GameRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.hostId = null;
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("ABYSSAL REDO room ready");
    }

    const players = this.ctx.getWebSockets();
    if (players.length >= 4) {
      return new Response("Sala llena", { status: 403 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const id = crypto.randomUUID();

    if (!this.hostId) this.hostId = id;
    const isHost = id === this.hostId;

    server.serializeAttachment({ id, isHost });
    this.ctx.acceptWebSocket(server);

    const currentPlayers = this.ctx.getWebSockets();
    server.send(JSON.stringify({
      type: "welcome",
      id,
      hostId: this.hostId,
      isHost,
      players: currentPlayers.length,
      maxPlayers: 4
    }));

    for (const player of currentPlayers) {
      if (player === server) continue;
      try {
        player.send(JSON.stringify({
          type: "player-joined",
          id,
          hostId: this.hostId,
          players: currentPlayers.length
        }));
      } catch {}
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket, message) {
    // Relay messages unchanged; the game validates message types and payloads.
    for (const player of this.ctx.getWebSockets()) {
      if (player === socket) continue;
      try { player.send(message); } catch {}
    }
  }

  async webSocketClose(socket) {
    const attachment = socket.deserializeAttachment() || {};
    const leavingId = attachment.id;
    const players = this.ctx.getWebSockets();

    if (leavingId && leavingId === this.hostId) {
      const notice = JSON.stringify({ type: "host-left", hostId: leavingId });
      for (const player of players) {
        try { player.send(notice); } catch {}
        try { player.close(4001, "host-left"); } catch {}
      }
      this.hostId = null;
      return;
    }

    const count = players.length;
    for (const player of players) {
      try {
        player.send(JSON.stringify({
          type: "player-left",
          id: leavingId || null,
          hostId: this.hostId,
          players: count
        }));
      } catch {}
    }
  }

  async webSocketError(socket) {
    try { socket.close(1011, "socket-error"); } catch {}
  }
}

export default {
  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response("ABYSSAL REDO SERVER ONLINE", { headers: cors });
    }

    if (url.pathname === "/create") {
      const code = crypto.randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase();
      const room = env.ROOMS.getByName(code);
      await room.fetch("https://room/init");
      return Response.json({ code }, { headers: cors });
    }

    if (url.pathname.startsWith("/join/")) {
      const code = url.pathname.split("/").pop().toUpperCase();
      if (!/^[A-F0-9]{6}$/.test(code)) {
        return new Response("Código inválido", { status: 400, headers: cors });
      }
      const room = env.ROOMS.getByName(code);
      return room.fetch(request);
    }

    return new Response("Ruta no encontrada", { status: 404, headers: cors });
  }
};
