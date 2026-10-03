export type NowPlayingModeState =
  | "reactive_fallback"
  | "premade_armed"
  | "premade_active";

export interface NowPlayingObservation {
  sourceApp: string;
  title: string;
  artist: string | null;
  durationSeconds: number;
  observedAt: string;
  playbackPositionSeconds: number | null;
  /**
   * How the position was obtained; see `PositionSource` in models.py.
   *
   * "exact" is a real transport clock from the source app. "estimated" is
   * inferred from how far through the file Rekordbox has read, which never
   * moves backwards and so cannot survive a loop or a cue jump.
   */
  positionSource: "exact" | "estimated" | null;
  isPlaying: boolean | null;
}

export interface NowPlayingArmedShow {
  id: string;
  showUrl: string | null;
}

export interface NowPlayingPreparedAudio {
  path: string;
  audioUrl: string | null;
  durationSeconds: number;
  provider: string;
}

export interface NowPlayingPreparation {
  showId: string;
  stage: string;
  message: string;
}

export interface NowPlayingProviderAttempt {
  provider: string;
  status: string;
  message: string;
}

export interface RekordboxOpenAudioCandidateDiagnostic {
  path: string;
  title: string | null;
  artist: string | null;
  contentId: string | null;
  currentOffset: number;
  previousOffset: number | null;
  offsetDelta: number | null;
  fileSize: number | null;
  bufferRatio: number | null;
  isFullyBuffered: boolean;
  recentEventAt: string | null;
  selected: boolean;
  matchedRecord: boolean;
}

export interface NowPlayingSourceDiagnostics {
  sourceApp: string;
  databaseLoaded: boolean;
  selectedPath: string | null;
  selectedContentId: string | null;
  selectedVia: string | null;
  openAudioCandidates: RekordboxOpenAudioCandidateDiagnostic[];
  recentEventContentIds: string[];
}

export interface NowPlayingStatus {
  modeState: NowPlayingModeState;
  observation: NowPlayingObservation | null;
  activeShowId: string | null;
  armedShow: NowPlayingArmedShow | null;
  preparedAudio: NowPlayingPreparedAudio | null;
  preparing: NowPlayingPreparation | null;
  providerAttempts: NowPlayingProviderAttempt[];
  sourceDiagnostics?: NowPlayingSourceDiagnostics | null;
  /** One line on whether measured tempo is available; see track_analysis.py. */
  analyzer?: string | null;
}

/**
 * One live sample of the Rekordbox master deck playhead from /api/now-playing/clock.
 *
 * positionSeconds is the raw sample position at sampling time; ageMs says how
 * long ago that was, so a playing deck has already moved positionSeconds +
 * ageMs/1000 by the time the payload arrives.
 */
export interface NowPlayingClockSample {
  status: string;
  deck: number | null;
  positionSeconds: number | null;
  playing: boolean | null;
  bpm: number | null;
  title: string | null;
  artist: string | null;
  ageMs: number | null;
}
