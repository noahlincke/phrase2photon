export type Fb4CueCatalogSource =
  | "packet-generated"
  | "placeholder-generated"
  | "observed-local"
  | "local-override";

export interface Fb4CueCatalogEntry {
  page: number;
  cue: number;
  category: string;
  name: string;
  description: string;
  source: Fb4CueCatalogSource;
  observedShape: string;
  notes: string;
  slug: string;
  thumbnailPath: string | null;
}

export interface Fb4CueCatalogOverride {
  name?: string;
  description?: string;
}
