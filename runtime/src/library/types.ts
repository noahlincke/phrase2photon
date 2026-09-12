export interface LibraryTrack {
  id: string;
  title: string;
  artist: string | null;
  abletonProjectPath: string | null;
  audioPath: string;
  showPath: string;
  bpm: number | null;
  notes?: string;
}

export interface PublicLibraryTrack {
  id: string;
  title: string;
  artist: string | null;
  abletonProjectPath: string | null;
  bpm: number | null;
  notes?: string;
  audioUrl: string;
  showUrl: string;
  exportShowUrl: string;
}

export interface LibraryRegistry {
  version: 1;
  tracks: LibraryTrack[];
}
