
import { DurableObject } from "cloudflare:workers";

export class GameRoom extends DurableObject {
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

    this.ctx.acceptWebSocket(server);

    server.send(JSON.stringify({
      type: "welcome",
      players: players.length + 1,
      maxPlayers: 4
    }));

    for (const player of players) {
      player.send(JSON.stringify({ type: "player-joined" }));
    }

    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }

  async webSocketMessage(socket, message) {
    for (const player of this.ctx.getWebSockets()) {
      if (player !== socket) {
        player.send(message);
      }
    }
  }

  async webSocketClose(socket) {
    for (const player of this.ctx.getWebSockets()) {
      if (player !== socket) {
        player.send(JSON.stringify({ type: "player-left" }));
      }
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response("ABYSSAL REDO SERVER ONLINE");
    }

    if (url.pathname === "/create") {
      const code = crypto.randomUUID()
        .replaceAll("-", "")
        .slice(0, 6)
        .toUpperCase();

      const room = env.ROOMS.getByName(code);

      await room.fetch("https://room/init");

      return Response.json({ code });
    }

    if (url.pathname.startsWith("/join/")) {
      const code = url.pathname.split("/").pop().toUpperCase();

      if (!/^[A-F0-9]{6}$/.test(code)) {
        return new Response("Código inválido", { status: 400 });
      }

      const room = env.ROOMS.getByName(code);
      return room.fetch(request);
    }

    return new Response("Ruta no encontrada", { status: 404 });
  }
};
