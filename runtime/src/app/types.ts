import type { PublicLibraryTrack } from "../library/types.js";
import type { ShowPackage } from "../show/types.js";

export type RuntimeInputMode = "library" | "mic" | "now-playing";

export interface LoadedTrack {
  libraryTrack: PublicLibraryTrack;
  show: ShowPackage;
}
