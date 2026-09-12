import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { LibraryRegistry, LibraryTrack, PublicLibraryTrack } from "./types.js";

const DEFAULT_LIBRARY_PATH = join(homedir(), "Phrase2PhotonShows", "library.json");

export function defaultLibraryPath(): string {
  return process.env.P2P_LIBRARY_PATH || DEFAULT_LIBRARY_PATH;
}

export async function loadLibraryRegistry(path = defaultLibraryPath()): Promise<LibraryRegistry> {
  if (!existsSync(path)) {
    return { version: 1, tracks: [] };
  }

  const payload = JSON.parse(await readFile(path, "utf8")) as LibraryRegistry;
  return {
    version: 1,
    tracks: payload.tracks.map(normalizeTrack)
  };
}

export async function getLibraryTrack(id: string, path = defaultLibraryPath()): Promise<LibraryTrack | null> {
  const registry = await loadLibraryRegistry(path);
  return registry.tracks.find((track) => track.id === id) ?? null;
}

export function toPublicTrack(track: LibraryTrack): PublicLibraryTrack {
  return {
    id: track.id,
    title: track.title,
    artist: track.artist,
    abletonProjectPath: track.abletonProjectPath,
    bpm: track.bpm,
    notes: track.notes,
    audioUrl: `/media/${encodeURIComponent(track.id)}`,
    showUrl: `/api/library/${encodeURIComponent(track.id)}/show`,
    exportShowUrl: `/api/library/${encodeURIComponent(track.id)}/export-show`
  };
}

function normalizeTrack(track: LibraryTrack): LibraryTrack {
  return {
    ...track,
    artist: track.artist ?? null,
    abletonProjectPath: track.abletonProjectPath ? resolve(expandHome(track.abletonProjectPath)) : null,
    audioPath: resolve(expandHome(track.audioPath)),
    showPath: resolve(expandHome(track.showPath)),
    bpm: track.bpm ?? null
  };
}

function expandHome(path: string): string {
  if (path === "~") {
    return homedir();
  }
  if (path.startsWith("~/")) {
    return join(homedir(), path.slice(2));
  }
  return path;
}
