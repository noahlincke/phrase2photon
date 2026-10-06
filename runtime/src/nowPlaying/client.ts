import type { NowPlayingClockSample, NowPlayingObservation, NowPlayingStatus } from "./types.js";

export async function fetchNowPlayingStatus(
  fetchImpl = fetch
): Promise<NowPlayingStatus> {
  const response = await fetchImpl("/api/now-playing/status");
  if (!response.ok) {
    throw new Error(`Now Playing status failed: ${response.status}`);
  }

  return validateNowPlayingStatus(await response.json());
}

export async function fetchNowPlayingClock(
  fetchImpl = fetch
): Promise<NowPlayingClockSample> {
  const response = await fetchImpl("/api/now-playing/clock");
  if (!response.ok) {
    throw new Error(`Now Playing clock failed: ${response.status}`);
  }

  return validateNowPlayingClock(await response.json());
}

function validateNowPlayingClock(payload: unknown): NowPlayingClockSample {
  if (!isRecord(payload)) {
    throw new Error("Invalid Now Playing clock: expected object payload");
  }

  return {
    status: typeof payload.status === "string" ? payload.status : "",
    deck: readNumber(payload, "deck", "deck"),
    positionSeconds: readNumber(payload, "positionSeconds", "position_seconds"),
    playing: readBoolean(payload, "playing", "playing"),
    bpm: readNumber(payload, "bpm", "bpm"),
    title: readString(payload, "title", "title"),
    artist: readString(payload, "artist", "artist"),
    ageMs: readNumber(payload, "ageMs", "age_ms"),
    showId: readString(payload, "showId", "show_id")
  };
}

function validateNowPlayingStatus(payload: unknown): NowPlayingStatus {
  if (!isRecord(payload)) {
    throw new Error("Invalid Now Playing status: expected object payload");
  }

  const { modeState, observation, activeShowId, armedShow, preparedAudio, preparing, providerAttempts } =
    payload;
  const sourceDiagnostics = payload.sourceDiagnostics ?? payload.source_diagnostics ?? null;

  if (
    modeState !== "reactive_fallback" &&
    modeState !== "premade_armed" &&
    modeState !== "premade_active"
  ) {
    throw new Error(`Invalid Now Playing status: invalid modeState ${String(modeState)}`);
  }

  if (observation !== null && !isNowPlayingObservation(observation)) {
    throw new Error("Invalid Now Playing status: invalid observation");
  }

  if (activeShowId !== null && typeof activeShowId !== "string") {
    throw new Error("Invalid Now Playing status: invalid activeShowId");
  }

  if (armedShow !== null && !isArmedShow(armedShow)) {
    throw new Error("Invalid Now Playing status: invalid armedShow");
  }

  if (preparedAudio !== null && !isPreparedAudio(preparedAudio)) {
    throw new Error("Invalid Now Playing status: invalid preparedAudio");
  }

  if (preparing !== null && !isPreparation(preparing)) {
    throw new Error("Invalid Now Playing status: invalid preparing");
  }

  if (!Array.isArray(providerAttempts)) {
    throw new Error("Invalid Now Playing status: providerAttempts must be an array");
  }
  for (const attempt of providerAttempts) {
    if (!isProviderAttempt(attempt)) {
      throw new Error("Invalid Now Playing status: invalid providerAttempts entry");
    }
  }

  if (sourceDiagnostics !== null && !isSourceDiagnostics(sourceDiagnostics)) {
    throw new Error("Invalid Now Playing status: invalid sourceDiagnostics");
  }

  return {
    modeState,
    observation: normalizeObservation(observation),
    activeShowId,
    armedShow,
    preparedAudio,
    preparing,
    providerAttempts,
    sourceDiagnostics: normalizeSourceDiagnostics(sourceDiagnostics)
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNowPlayingObservation(value: unknown): value is NowPlayingStatus["observation"] {
  if (!isRecord(value)) {
    return false;
  }

  return (
    readString(value, "sourceApp", "source_app") !== null &&
    typeof value.title === "string" &&
    isNullableString(value.artist) &&
    typeof readNumber(value, "durationSeconds", "duration_seconds") === "number" &&
    typeof readString(value, "observedAt", "observed_at") === "string" &&
    isNullableNumber(readNumber(value, "playbackPositionSeconds", "playback_position_seconds")) &&
    isNullableBoolean(readBoolean(value, "isPlaying", "is_playing"))
  );
}

function normalizeObservation(
  value: NowPlayingStatus["observation"] | Record<string, unknown> | null
): NowPlayingStatus["observation"] {
  if (value === null) {
    return null;
  }

  const record = value as Record<string, unknown>;

  return {
    sourceApp: readString(record, "sourceApp", "source_app") ?? "",
    title: typeof record.title === "string" ? record.title : "",
    artist: typeof record.artist === "string" ? record.artist : null,
    durationSeconds: readNumber(record, "durationSeconds", "duration_seconds") ?? 0,
    observedAt: readString(record, "observedAt", "observed_at") ?? "",
    playbackPositionSeconds: readNumber(record, "playbackPositionSeconds", "playback_position_seconds"),
    positionSource: readPositionSource(record),
    isPlaying: readBoolean(record, "isPlaying", "is_playing"),
    deck: readNumber(record, "deck", "deck")
  };
}

function isArmedShow(value: unknown): value is NonNullable<NowPlayingStatus["armedShow"]> {
  if (!isRecord(value)) {
    return false;
  }

  return typeof value.id === "string" && isNullableString(value.showUrl);
}

function isPreparedAudio(
  value: unknown
): value is NonNullable<NowPlayingStatus["preparedAudio"]> {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.path === "string" &&
    isNullableString(value.audioUrl) &&
    typeof value.durationSeconds === "number" &&
    Number.isFinite(value.durationSeconds) &&
    typeof value.provider === "string"
  );
}

function isPreparation(
  value: unknown
): value is NonNullable<NowPlayingStatus["preparing"]> {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.showId === "string" &&
    typeof value.stage === "string" &&
    typeof value.message === "string"
  );
}

function isProviderAttempt(
  value: unknown
): value is NowPlayingStatus["providerAttempts"][number] {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.provider === "string" &&
    typeof value.status === "string" &&
    typeof value.message === "string"
  );
}

function isSourceDiagnostics(
  value: unknown
): value is NonNullable<NowPlayingStatus["sourceDiagnostics"]> {
  if (!isRecord(value)) {
    return false;
  }

  const openAudioCandidates = value.openAudioCandidates ?? value.open_audio_candidates;
  const recentEventContentIds = value.recentEventContentIds ?? value.recent_event_content_ids;

  return (
    readString(value, "sourceApp", "source_app") !== null &&
    typeof readBoolean(value, "databaseLoaded", "database_loaded") === "boolean" &&
    isNullableString(value.selectedPath ?? value.selected_path) &&
    isNullableString(value.selectedContentId ?? value.selected_content_id) &&
    isNullableString(value.selectedVia ?? value.selected_via) &&
    Array.isArray(openAudioCandidates) &&
    openAudioCandidates.every((candidate) => isOpenAudioCandidate(candidate)) &&
    Array.isArray(recentEventContentIds) &&
    recentEventContentIds.every((item) => typeof item === "string")
  );
}

function isOpenAudioCandidate(
  value: unknown
): value is NonNullable<NowPlayingStatus["sourceDiagnostics"]>["openAudioCandidates"][number] {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.path === "string" &&
    isNullableString(value.title) &&
    isNullableString(value.artist) &&
    isNullableString(value.contentId ?? value.content_id) &&
    typeof readNumber(value, "currentOffset", "current_offset") === "number" &&
    isNullableNumber(readNumber(value, "previousOffset", "previous_offset")) &&
    isNullableNumber(readNumber(value, "offsetDelta", "offset_delta")) &&
    isNullableNumber(readNumber(value, "fileSize", "file_size")) &&
    isNullableNumber(readNumber(value, "bufferRatio", "buffer_ratio")) &&
    typeof readBoolean(value, "isFullyBuffered", "is_fully_buffered") === "boolean" &&
    isNullableString(value.recentEventAt ?? value.recent_event_at) &&
    typeof readBoolean(value, "selected", "selected") === "boolean" &&
    typeof readBoolean(value, "matchedRecord", "matched_record") === "boolean"
  );
}

function normalizeSourceDiagnostics(
  value: NowPlayingStatus["sourceDiagnostics"] | Record<string, unknown> | null
): NowPlayingStatus["sourceDiagnostics"] {
  if (value === null) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const openAudioCandidates = Array.isArray(record.openAudioCandidates ?? record.open_audio_candidates)
    ? ((record.openAudioCandidates ?? record.open_audio_candidates) as unknown[])
    : [];
  const recentEventContentIds = Array.isArray(record.recentEventContentIds ?? record.recent_event_content_ids)
    ? ((record.recentEventContentIds ?? record.recent_event_content_ids) as unknown[])
    : [];

  return {
    sourceApp: readString(record, "sourceApp", "source_app") ?? "",
    databaseLoaded: readBoolean(record, "databaseLoaded", "database_loaded") ?? false,
    selectedPath: readString(record, "selectedPath", "selected_path"),
    selectedContentId: readString(record, "selectedContentId", "selected_content_id"),
    selectedVia: readString(record, "selectedVia", "selected_via"),
    openAudioCandidates: openAudioCandidates.map((candidate: unknown) =>
      normalizeOpenAudioCandidate(candidate as Record<string, unknown>)
    ),
    recentEventContentIds: recentEventContentIds.filter((item: unknown): item is string => typeof item === "string")
  };
}

function normalizeOpenAudioCandidate(
  value: Record<string, unknown>
): NonNullable<NowPlayingStatus["sourceDiagnostics"]>["openAudioCandidates"][number] {
  return {
    path: typeof value.path === "string" ? value.path : "",
    title: typeof value.title === "string" ? value.title : null,
    artist: typeof value.artist === "string" ? value.artist : null,
    contentId: readString(value, "contentId", "content_id"),
    currentOffset: readNumber(value, "currentOffset", "current_offset") ?? 0,
    previousOffset: readNumber(value, "previousOffset", "previous_offset"),
    offsetDelta: readNumber(value, "offsetDelta", "offset_delta"),
    fileSize: readNumber(value, "fileSize", "file_size"),
    bufferRatio: readNumber(value, "bufferRatio", "buffer_ratio"),
    isFullyBuffered: readBoolean(value, "isFullyBuffered", "is_fully_buffered") ?? false,
    recentEventAt: readString(value, "recentEventAt", "recent_event_at"),
    selected: readBoolean(value, "selected", "selected") ?? false,
    matchedRecord: readBoolean(value, "matchedRecord", "matched_record") ?? false
  };
}

function readPositionSource(
  value: Record<string, unknown>
): NowPlayingObservation["positionSource"] {
  const candidate = readString(value, "positionSource", "position_source");
  return candidate === "exact" || candidate === "estimated" ? candidate : null;
}

function readString(
  value: Record<string, unknown>,
  camelKey: string,
  snakeKey: string
): string | null {
  const candidate = value[camelKey] ?? value[snakeKey];
  return typeof candidate === "string" ? candidate : null;
}

function readNumber(
  value: Record<string, unknown>,
  camelKey: string,
  snakeKey: string
): number | null {
  const candidate = value[camelKey] ?? value[snakeKey];
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : null;
}

function readBoolean(
  value: Record<string, unknown>,
  camelKey: string,
  snakeKey: string
): boolean | null {
  const candidate = value[camelKey] ?? value[snakeKey];
  return typeof candidate === "boolean" ? candidate : null;
}

function isNullableNumber(value: number | null): value is number | null {
  return value === null || Number.isFinite(value);
}

function isNullableBoolean(value: boolean | null): value is boolean | null {
  return value === null || typeof value === "boolean";
}
