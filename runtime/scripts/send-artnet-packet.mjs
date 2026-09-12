import dgram from "node:dgram";

const [, , host, portRaw, packetBase64] = process.argv;

if (!host || !portRaw || !packetBase64) {
  console.error("Usage: send-artnet-packet.mjs <host> <port> <packet-base64>");
  process.exit(1);
}

const port = Number.parseInt(portRaw, 10);
const packet = Buffer.from(packetBase64, "base64");
const socket = dgram.createSocket("udp4");

await new Promise((resolve, reject) => {
  socket.once("error", reject);
  socket.send(packet, port, host, (error) => {
    try {
      socket.close();
    } catch {}
    if (error) {
      reject(error);
    } else {
      resolve();
    }
  });
});
