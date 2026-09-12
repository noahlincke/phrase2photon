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
}
