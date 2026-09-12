export interface AudioInputDeviceLike {
  deviceId: string;
  kind: "audioinput";
  label: string;
}

interface ResolvePreferredAudioInputOptions {
  devices: AudioInputDeviceLike[];
  savedDeviceId: string | null;
  userSelected: boolean;
}

const LOOPBACK_LIKE_LABELS = [
  "loopback",
  "blackhole",
  "black hole",
  "soundflower",
  "vb-cable",
  "stereo mix",
  "monitor of"
];

export function resolvePreferredAudioInput(options: ResolvePreferredAudioInputOptions): string | null {
  const { devices, savedDeviceId, userSelected } = options;
  if (!devices.length) {
    return null;
  }

  const savedDevice = savedDeviceId
    ? devices.find((device) => device.deviceId === savedDeviceId) ?? null
    : null;
  if (userSelected && savedDevice) {
    return savedDevice.deviceId;
  }

  const loopbackLikeDevice = devices.find((device) => isLoopbackLikeAudioInput(device.label));
  if (loopbackLikeDevice) {
    return loopbackLikeDevice.deviceId;
  }

  if (savedDevice) {
    return savedDevice.deviceId;
  }

  const browserDefault = devices.find((device) => device.deviceId === "default");
  return browserDefault?.deviceId ?? devices[0]?.deviceId ?? null;
}

export function describeAudioInputDevice(device: AudioInputDeviceLike, index: number): string {
  const label = device.label.trim();
  if (label) {
    return label;
  }
  return `Input ${index + 1}`;
}

export function isAudioInputDevice(device: MediaDeviceInfo): device is MediaDeviceInfo & AudioInputDeviceLike {
  return device.kind === "audioinput";
}

export function buildMicAudioConstraints(deviceId: string | null | undefined): MediaTrackConstraints {
  const resolvedDeviceId = deviceId?.trim() || null;
  return {
    deviceId: resolvedDeviceId && resolvedDeviceId !== "default" ? { exact: resolvedDeviceId } : undefined,
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false
  };
}

function isLoopbackLikeAudioInput(label: string): boolean {
  const normalized = label.trim().toLowerCase();
  return LOOPBACK_LIKE_LABELS.some((token) => normalized.includes(token));
}
