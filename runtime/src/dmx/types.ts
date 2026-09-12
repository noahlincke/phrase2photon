export type DmxOutputIntent =
  | {
      kind: "lighting";
      cueId: string;
      phraseId: string;
      fixtureGroup: string;
      intensity: number;
      palette: string;
      strobe: boolean;
    }
  | {
      kind: "dmx_laser";
      cueId: string;
      phraseId: string;
      fixtureGroup: string;
      mode: string;
      parameters: Record<string, number | string>;
    };

export interface DmxFrame {
  universe: number;
  channels: Uint8Array;
}

export interface OutputAdapter {
  publish(intents: DmxOutputIntent[]): Promise<void> | void;
  blackout(): Promise<void> | void;
}
