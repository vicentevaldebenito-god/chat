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

    // Una sala que ya comenzó no admite nuevos jugadores.
    if (await this.ctx.storage.get("lobbyStarted")) {
      return new Response("La partida ya comenzó", { status: 403 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const id = crypto.randomUUID();

    let hostId = await this.ctx.storage.get("hostId");
    if (!hostId || players.length === 0) {
      hostId = id;
      await this.ctx.storage.put("hostId", hostId);
      await this.ctx.storage.delete("lobbyStarted");
    }

    const isHost = id === hostId;
    server.serializeAttachment({ id, isHost, ready: false });
    this.ctx.acceptWebSocket(server);

    const currentPlayers = this.ctx.getWebSockets();

    server.send(JSON.stringify({
      type: "welcome",
      id,
      hostId,
      isHost,
      players: currentPlayers.length,
      maxPlayers: 4
    }));

    // Todos reciben el mismo estado del lobby, incluidos los READY.
    await this.broadcastLobbyState();

    for (const player of currentPlayers) {
      if (player === server) continue;
      try {
        player.send(JSON.stringify({
          type: "player-joined",
          id,
          hostId,
          players: currentPlayers.length
        }));
      } catch {}
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async broadcastLobbyState() {
    const players = this.ctx.getWebSockets();
    const hostId = await this.ctx.storage.get("hostId");
    const readyIds = [];

    for (const player of players) {
      const attachment = player.deserializeAttachment() || {};
      if (attachment.ready) readyIds.push(attachment.id);
    }

    const state = JSON.stringify({
      type: "lobby-state",
      players: players.length,
      maxPlayers: 4,
      hostId: hostId || null,
      readyIds,
      readyCount: readyIds.length,
      lobbyStarted: Boolean(await this.ctx.storage.get("lobbyStarted"))
    });

    for (const player of players) {
      try {
        player.send(state);
      } catch {}
    }
  }

  async closeRoomForHost(leavingId) {
    const players = this.ctx.getWebSockets();
    const notice = JSON.stringify({
      type: "host-left",
      hostId: leavingId || null
    });

    // Limpiar primero el estado para que el cierre sea idempotente.
    await this.ctx.storage.delete("hostId");
    await this.ctx.storage.delete("lobbyStarted");

    for (const player of players) {
      try {
        player.send(notice);
      } catch {}
      try {
        player.close(4001, "host-left");
      } catch {}
    }
  }

  async webSocketMessage(socket, message) {
    let data;
    try {
      data = JSON.parse(
        typeof message === "string"
          ? message
          : await new Response(message).text()
      );
    } catch {
      return;
    }

    const attachment = socket.deserializeAttachment() || {};

    if (data.type === "room-leave") {
      const hostId = await this.ctx.storage.get("hostId");

      if (attachment.isHost || attachment.id === hostId) {
        await this.closeRoomForHost(attachment.id);
      } else {
        try {
          socket.close(1000, "left-room");
        } catch {}
      }
      return;
    }

    // READY: el servidor, no cada cliente, decide cuándo están todos listos.
    if (data.type === "lobby-ready") {
      if (await this.ctx.storage.get("lobbyStarted")) return;

      const activePlayers = this.ctx.getWebSockets();
      if (!activePlayers.includes(socket)) return;

      attachment.ready = data.ready === true;
      socket.serializeAttachment(attachment);

      await this.broadcastLobbyState();

      const everyoneReady =
        activePlayers.length > 0 &&
        activePlayers.every((player) => {
          const playerData = player.deserializeAttachment() || {};
          return playerData.ready === true;
        });

      if (everyoneReady && !(await this.ctx.storage.get("lobbyStarted"))) {
        // Se marca antes de avisar para impedir dos inicios simultáneos.
        await this.ctx.storage.put("lobbyStarted", true);

        const startMessage = JSON.stringify({
          type: "lobby-start",
          hostId: await this.ctx.storage.get("hostId"),
          players: activePlayers.length
        });

        for (const player of activePlayers) {
          try {
            player.send(startMessage);
          } catch {}
        }
      }
      return;
    }

    // Los demás mensajes del juego siguen retransmitiéndose a los compañeros.
    for (const player of this.ctx.getWebSockets()) {
      if (player === socket) continue;
      try {
        player.send(message);
      } catch {}
    }
  }

  async webSocketClose(socket) {
    const attachment = socket.deserializeAttachment() || {};
    const hostId = await this.ctx.storage.get("hostId");

    if (attachment.isHost || (attachment.id && attachment.id === hostId)) {
      await this.closeRoomForHost(attachment.id);
      return;
    }

    const players = this.ctx.getWebSockets();

    // Si alguien se desconecta antes de iniciar, se recalcula READY.
    await this.broadcastLobbyState();

    for (const player of players) {
      try {
        player.send(JSON.stringify({
          type: "player-left",
          id: attachment.id || null,
          hostId,
          players: players.length
        }));
      } catch {}
    }
  }

  async webSocketError(socket) {
    const attachment = socket.deserializeAttachment() || {};
    const hostId = await this.ctx.storage.get("hostId");

    if (attachment.isHost || (attachment.id && attachment.id === hostId)) {
      await this.closeRoomForHost(attachment.id);
    } else {
      try {
        socket.close(1011, "socket-error");
      } catch {}
    }
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
      const code = crypto.randomUUID()
        .replaceAll("-", "")
        .slice(0, 6)
        .toUpperCase();

      const room = env.ROOMS.getByName(code);
      await room.fetch("https://room/init");

      return Response.json({ code }, { headers: cors });
    }

    if (url.pathname.startsWith("/join/")) {
      const code = url.pathname.split("/").pop().toUpperCase();

      if (!/^[A-F0-9]{6}$/.test(code)) {
        return new Response("Código inválido", {
          status: 400,
          headers: cors
        });
      }

      const room = env.ROOMS.getByName(code);
      return room.fetch(request);
    }

    return new Response("Ruta no encontrada", {
      status: 404,
      headers: cors
    });
  }
};
