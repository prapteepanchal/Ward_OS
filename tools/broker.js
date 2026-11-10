// ============================================================
// WardOS - Local MQTT broker (offline / LAN use)
//   TCP        mqtt://0.0.0.0:1883        (ESP32 bands)
//   WebSocket  ws://0.0.0.0:9001/mqtt     (WardOS server)
// Use Mosquitto instead if you already run it - same ports.
// ============================================================

import net from "node:net";
import http from "node:http";
import { Aedes } from "aedes";
import { WebSocketServer, createWebSocketStream } from "ws";

const TCP_PORT = Number(process.env.MQTT_TCP_PORT || 1883);
const WS_PORT = Number(process.env.MQTT_WS_PORT || 9001);

export async function startBroker({ tcpPort = TCP_PORT, wsPort = WS_PORT, quiet = false } = {}) {
  const broker = await Aedes.createBroker();

  const tcp = net.createServer(broker.handle);
  await new Promise((resolve, reject) => tcp.once("error", reject).listen(tcpPort, resolve));

  const httpServer = http.createServer((req, res) => { res.writeHead(426); res.end("MQTT over WebSocket only"); });
  const wss = new WebSocketServer({ server: httpServer, path: "/mqtt" });
  wss.on("connection", ws => broker.handle(createWebSocketStream(ws)));
  await new Promise((resolve, reject) => httpServer.once("error", reject).listen(wsPort, resolve));

  if (!quiet) {
    broker.on("client", client => console.log(`[Broker] client connected: ${client.id}`));
    broker.on("clientDisconnect", client => console.log(`[Broker] client disconnected: ${client.id}`));
  }

  console.log(`[Broker] MQTT tcp://localhost:${tcpPort}  ws://localhost:${wsPort}/mqtt`);

  return {
    broker,
    close: () => new Promise(resolve => {
      wss.close();
      httpServer.close();
      tcp.close();
      broker.close(resolve);
    })
  };
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("tools/broker.js")) {
  startBroker().catch(error => {
    console.error(`[Broker] Failed to start: ${error.message}. Is another broker (e.g. Mosquitto) already using these ports?`);
    process.exit(1);
  });
}
