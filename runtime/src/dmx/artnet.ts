import { execFile } from "node:child_process";
import dgram from "node:dgram";
import { resolve } from "node:path";
import { promisify } from "node:util";

export interface ArtNetFrame {
  host: string;
  port?: number;
  universe: number;
  channels: number[];
}

export interface ArtNetSendResult {
  host: string;
  port: number;
  universe: number;
  bytes: number;
}

interface ArtNetPacketRequest {
  host: string;
  port: number;
  universe: number;
  packet: Buffer;
}

interface ArtNetTransportResult {
  preferFreshProcess: boolean;
}

interface ArtNetTransportDeps {
  preferFreshProcess: boolean;
  sendViaSocket: (host: string, port: number, packet: Buffer) => Promise<void>;
  sendViaFreshProcess: (host: string, port: number, packet: Buffer) => Promise<void>;
}

const execFileAsync = promisify(execFile);
let preferFreshProcess = false;

export async function sendArtDmx(frame: ArtNetFrame): Promise<ArtNetSendResult> {
  const port = frame.port ?? 6454;
  const packet = buildArtDmxPacket(frame.universe, frame.channels);
  const transport = await sendArtDmxWithTransports(
    {
      host: frame.host,
      port,
      universe: frame.universe,
      packet
    },
    {
      preferFreshProcess,
      sendViaSocket: sendPacketViaSocket,
      sendViaFreshProcess: sendPacketViaFreshProcess
    }
  );
  preferFreshProcess = transport.preferFreshProcess;

  return {
    host: frame.host,
    port,
    universe: frame.universe,
    bytes: packet.length
  };
}

export async function sendArtDmxWithTransports(
  request: ArtNetPacketRequest,
  deps: ArtNetTransportDeps
): Promise<ArtNetTransportResult> {
  if (deps.preferFreshProcess) {
    await deps.sendViaFreshProcess(request.host, request.port, request.packet);
    return { preferFreshProcess: true };
  }

  try {
    await deps.sendViaSocket(request.host, request.port, request.packet);
    return { preferFreshProcess: false };
  } catch (error) {
    if (!isHostUnreachableError(error)) {
      throw error;
    }
    await deps.sendViaFreshProcess(request.host, request.port, request.packet);
    return { preferFreshProcess: true };
  }
}

async function sendPacketViaSocket(host: string, port: number, packet: Buffer): Promise<void> {
  const socket = dgram.createSocket("udp4");

  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.send(packet, port, host, (error) => {
      socket.close();
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

async function sendPacketViaFreshProcess(host: string, port: number, packet: Buffer): Promise<void> {
  await execFileAsync(process.execPath, [resolve(process.cwd(), "scripts/send-artnet-packet.mjs"), host, String(port), packet.toString("base64")]);
}

function isHostUnreachableError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.message.includes("EHOSTUNREACH") || (error as NodeJS.ErrnoException).code === "EHOSTUNREACH";
}

export function buildArtDmxPacket(universe: number, channels: number[]): Buffer {
  const dmx = Buffer.alloc(512);
  channels.slice(0, 512).forEach((value, index) => {
    dmx[index] = clampByte(value);
  });

  const packet = Buffer.alloc(18 + dmx.length);
  packet.write("Art-Net\0", 0, "ascii");
  packet[8] = 0x00;
  packet[9] = 0x50;
  packet[10] = 0x00;
  packet[11] = 14;
  packet[12] = 0x00;
  packet[13] = 0x00;
  packet.writeUInt16LE(universe, 14);
  packet[16] = 0x02;
  packet[17] = 0x00;
  dmx.copy(packet, 18);
  return packet;
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}
