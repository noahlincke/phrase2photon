import type { NowPlayingModeState, NowPlayingStatus } from "./types.js";

export interface NowPlayingSession {
  outputMode: NowPlayingModeState;
  activeShowId: string | null;
  pendingShowId: string | null;
  latestObservedAt: string | null;
}

export interface NowPlayingPlayback {
  showId: string;
  phraseId: string;
}

export interface ApplyNowPlayingStatusInput {
  nowMs: number;
  status: NowPlayingStatus;
  currentPlayback: NowPlayingPlayback | null;
  lastCueStartMs: number | null;
  cueBoundaryReached: boolean;
}

export function createNowPlayingSession(
  init: Partial<NowPlayingSession> = {}
): NowPlayingSession {
  return {
    outputMode: init.outputMode ?? "reactive_fallback",
    activeShowId: init.activeShowId ?? null,
    pendingShowId: init.pendingShowId ?? null,
    latestObservedAt: init.latestObservedAt ?? null
  };
}

export function applyNowPlayingStatus(
  session: NowPlayingSession,
  input: ApplyNowPlayingStatusInput
): NowPlayingSession {
  const observedAt = input.status.observation?.observedAt ?? null;
  if (
    session.latestObservedAt !== null &&
    observedAt !== null &&
    observedAt < session.latestObservedAt
  ) {
    return session;
  }

  const nextObservedAt = observedAt ?? session.latestObservedAt;
  const readyShow =
    input.status.armedShow !== null && input.status.preparedAudio !== null
      ? input.status.armedShow
      : null;

  if (
    input.status.modeState === "premade_active" &&
    input.status.activeShowId !== null &&
    readyShow === null
  ) {
    return {
      ...session,
      outputMode: "premade_active",
      activeShowId: input.status.activeShowId,
      pendingShowId: null,
      latestObservedAt: nextObservedAt
    };
  }

  if (readyShow === null) {
    return {
      ...session,
      outputMode: "reactive_fallback",
      activeShowId: null,
      pendingShowId: null,
      latestObservedAt: nextObservedAt
    };
  }

  if (input.currentPlayback === null) {
    return {
      ...session,
      outputMode: "premade_active",
      activeShowId: readyShow.id,
      pendingShowId: null,
      latestObservedAt: nextObservedAt
    };
  }

  if (input.currentPlayback.showId === readyShow.id) {
    return {
      ...session,
      outputMode: "premade_active",
      activeShowId: readyShow.id,
      pendingShowId: null,
      latestObservedAt: nextObservedAt
    };
  }

  const withinGraceWindow =
    input.lastCueStartMs !== null && input.nowMs - input.lastCueStartMs <= 2_000;
  if (withinGraceWindow || input.cueBoundaryReached) {
    return {
      ...session,
      outputMode: "premade_active",
      activeShowId: readyShow.id,
      pendingShowId: null,
      latestObservedAt: nextObservedAt
    };
  }

  return {
    ...session,
    outputMode: "premade_armed",
    activeShowId: input.currentPlayback.showId,
    pendingShowId: readyShow.id,
    latestObservedAt: nextObservedAt
  };
}
