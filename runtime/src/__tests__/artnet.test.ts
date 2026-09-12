import { describe, expect, it, vi } from "vitest";

import { sendArtDmxWithTransports } from "../dmx/artnet.js";

describe("Art-Net transport fallback", () => {
  it("switches to a fresh-process sender after EHOSTUNREACH", async () => {
    const packet = Buffer.alloc(530);
    const sendViaSocket = vi
      .fn<(_: string, __: number, ___: Buffer) => Promise<void>>()
      .mockRejectedValueOnce(Object.assign(new Error("send EHOSTUNREACH 2.168.0.5:6454"), { code: "EHOSTUNREACH" }));
    const sendViaFreshProcess = vi.fn<(_: string, __: number, ___: Buffer) => Promise<void>>().mockResolvedValue(undefined);

    const first = await sendArtDmxWithTransports(
      {
        host: "2.168.0.5",
        port: 6454,
        universe: 0,
        packet
      },
      {
        preferFreshProcess: false,
        sendViaSocket,
        sendViaFreshProcess
      }
    );

    expect(sendViaSocket).toHaveBeenCalledTimes(1);
    expect(sendViaFreshProcess).toHaveBeenCalledTimes(1);
    expect(first.preferFreshProcess).toBe(true);

    sendViaSocket.mockReset();
    sendViaFreshProcess.mockClear();

    await sendArtDmxWithTransports(
      {
        host: "2.168.0.5",
        port: 6454,
        universe: 0,
        packet
      },
      {
        preferFreshProcess: first.preferFreshProcess,
        sendViaSocket,
        sendViaFreshProcess
      }
    );

    expect(sendViaSocket).not.toHaveBeenCalled();
    expect(sendViaFreshProcess).toHaveBeenCalledTimes(1);
  });
});
