import { describe, expect, it } from "vitest";

import { describeAudioInputDevice, resolvePreferredAudioInput } from "../app/micInputDevices.js";

describe("mic input device selection", () => {
  const devices = [
    { deviceId: "default", kind: "audioinput" as const, label: "MacBook Pro Microphone" },
    { deviceId: "loopback-1", kind: "audioinput" as const, label: "Loopback Audio" },
    { deviceId: "usb-1", kind: "audioinput" as const, label: "USB Interface" }
  ];

  it("prefers a loopback-like device by default when one is present", () => {
    expect(resolvePreferredAudioInput({
      devices,
      savedDeviceId: null,
      userSelected: false
    })).toBe("loopback-1");
  });

  it("preserves the saved device when the user explicitly picked it", () => {
    expect(resolvePreferredAudioInput({
      devices,
      savedDeviceId: "usb-1",
      userSelected: true
    })).toBe("usb-1");
  });

  it("falls back to a loopback-like device when the saved device disappears", () => {
    expect(resolvePreferredAudioInput({
      devices: devices.slice(0, 2),
      savedDeviceId: "usb-1",
      userSelected: true
    })).toBe("loopback-1");
  });

  it("formats unnamed devices with a readable fallback label", () => {
    expect(describeAudioInputDevice({
      deviceId: "ghost",
      kind: "audioinput",
      label: ""
    }, 2)).toBe("Input 3");
  });
});
