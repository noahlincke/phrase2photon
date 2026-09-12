import { parentPort, workerData } from "node:worker_threads";

import { analyzeTrack } from "../../src/audio/analyzeTrack.js";
import { decodeMono } from "./decodeAudio.js";
import {
  referenceBoundaries,
  scoreBeats,
  scoreBoundaries,
  scoreEnergyContour,
  scorePhraseGrid,
  scoreTempo,
  type TruthSong
} from "./score.js";

interface WorkerConfig {
  sampleRate: number;
}

const config = workerData as WorkerConfig;

export interface TrackResult {
  songId: number;
  title: string;
  artist: string;
  path: string;
  ok: boolean;
  error?: string;
  durationSeconds?: number;
  analysisMs?: number;
  tempo?: ReturnType<typeof scoreTempo>;
  beats?: ReturnType<typeof scoreBeats>;
  boundaries?: ReturnType<typeof scoreBoundaries>;
  sectionBoundaries?: ReturnType<typeof scoreBoundaries>;
  grid?: ReturnType<typeof scorePhraseGrid>;
  energyCorrelation?: number;
  barEnergyCorrelation?: number;
  phraseCount?: number;
  downbeatConfidence?: number;
  tempoConfidence?: number;
}

async function run(song: TruthSong): Promise<TrackResult> {
  const base = { songId: song.songId, title: song.title, artist: song.artist, path: song.path };
  try {
    const samples = await decodeMono(song.path, config.sampleRate);
    if (samples.length < config.sampleRate * 20) {
      return { ...base, ok: false, error: "shorter than 20s of audio" };
    }
    const startedAt = Date.now();
    const analysis = analyzeTrack(samples, config.sampleRate);
    const analysisMs = Date.now() - startedAt;

    const ourBoundaries = analysis.phrases.slice(1).map((phrase) => phrase.startSeconds);
    // Mixed In Key only records a boundary where its energy value changes, so
    // compare like with like by merging our adjacent same-role phrases too.
    const sectionBoundaries = analysis.phrases
      .filter((phrase, index) => index > 0 && phrase.kind !== analysis.phrases[index - 1].kind)
      .map((phrase) => phrase.startSeconds);
    const truthBoundaries = referenceBoundaries(song);

    const energyAt = (seconds: number): number | null => {
      const phrase = analysis.phrases.find(
        (candidate) => seconds >= candidate.startSeconds && seconds < candidate.endSeconds
      );
      return phrase ? phrase.energy : null;
    };

    return {
      ...base,
      ok: true,
      durationSeconds: samples.length / config.sampleRate,
      analysisMs,
      tempo: scoreTempo(analysis.bpm, song.bpm),
      beats: scoreBeats(analysis.beatTimes, analysis.firstDownbeatSeconds, analysis.periodSeconds, song.beatTimes),
      boundaries: scoreBoundaries(ourBoundaries, truthBoundaries, analysis.barSeconds),
      sectionBoundaries: scoreBoundaries(sectionBoundaries, truthBoundaries, analysis.barSeconds),
      grid: scorePhraseGrid(ourBoundaries, song, analysis.barSeconds),
      energyCorrelation: scoreEnergyContour(energyAt, song),
      barEnergyCorrelation: scoreEnergyContour((seconds) => {
        const bar = analysis.barTimes.findIndex(
          (time, index) =>
            seconds >= time && (index + 1 >= analysis.barTimes.length || seconds < analysis.barTimes[index + 1])
        );
        return bar >= 0 ? analysis.barEnergy[bar] : null;
      }, song),
      phraseCount: analysis.phrases.length,
      downbeatConfidence: analysis.downbeatConfidence,
      tempoConfidence: analysis.tempoConfidence
    };
  } catch (error) {
    return { ...base, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

parentPort?.on("message", (song: TruthSong | null) => {
  if (song === null) {
    parentPort?.close();
    return;
  }
  void run(song).then((result) => parentPort?.postMessage(result));
});
