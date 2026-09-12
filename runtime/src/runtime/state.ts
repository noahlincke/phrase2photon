import type { BeatClockState } from "../clock/types.js";
import type { DmxOutputIntent } from "../dmx/types.js";
import type { Phrase, ShowPackage } from "../show/types.js";

export interface RuntimeState {
  show: ShowPackage;
  activePhrase: Phrase;
  clock: BeatClockState;
  phraseProgress: number;
  outputs: DmxOutputIntent[];
}

export function createRuntimeState(show: ShowPackage, clock: BeatClockState, phraseId?: string): RuntimeState {
  const activePhrase = selectPhrase(show, phraseId);
  return {
    show,
    activePhrase,
    clock,
    phraseProgress: 0,
    outputs: outputIntentsForPhrase(show, activePhrase.phrase_id)
  };
}

function selectPhrase(show: ShowPackage, phraseId: string | undefined): Phrase {
  if (!show.phrases.length) {
    throw new Error("Show package has no phrases.");
  }

  if (!phraseId) {
    return show.phrases[0];
  }

  const phrase = show.phrases.find((candidate) => candidate.phrase_id === phraseId);
  if (!phrase) {
    throw new Error(`Unknown phrase: ${phraseId}`);
  }
  return phrase;
}

function outputIntentsForPhrase(show: ShowPackage, phraseId: string): DmxOutputIntent[] {
  const lighting = show.lighting_cues
    .filter((cue) => cue.phrase_id === phraseId)
    .map<DmxOutputIntent>((cue) => ({
      kind: "lighting",
      cueId: cue.cue_id,
      phraseId,
      fixtureGroup: cue.fixture_group,
      intensity: cue.look.intensity,
      palette: cue.look.palette,
      strobe: cue.look.strobe
    }));

  const lasers = show.dmx_laser_cues
    .filter((cue) => cue.phrase_id === phraseId)
    .map<DmxOutputIntent>((cue) => ({
      kind: "dmx_laser",
      cueId: cue.cue_id,
      phraseId,
      fixtureGroup: cue.fixture_group,
      mode: cue.mode,
      parameters: cue.parameter_overrides
    }));

  return [...lighting, ...lasers];
}
