// The identity of every file BigMouth writes (file-identity-conventions): its
// owner, each format's kind (the key below) and the version this build reads.
// No imports: the backup recorder's worker runs this file from source.

/** `format.owner` of every BigMouth file: the product, never the repository. */
export const FORMAT_OWNER = "bigmouth";

/** `writer.name`: the package whose code serializes BigMouth's files. */
export const WRITER_NAME = "bigmouth";

/** Each format's version, keyed by its `format.kind`. */
export const FORMAT_VERSIONS = {
  /** A post's `.md` file, in its front matter. */
  post: 1,
  /** An asset folder's `assets.json`. */
  assetList: 1,
  /** The storage root's `workspaces.json`. */
  workspaces: 1,
  /** The storage root's `config.json`. */
  appConfig: 1,
  /** A workspace's `config.json`. */
  workspaceConfig: 1,
  /** `state.json`. */
  state: 1,
  /** `api-keys.json`. */
  apiKeys: 1,
  /** `records.sqlite3`. */
  records: 1,
  /** `backups.sqlite3`. */
  backups: 1,
} as const;

export type StoreFormat = keyof typeof FORMAT_VERSIONS;

/** `writer` as a file records it; written on every save, never read. */
export type FileWriter = { name: string; version: string };

/** Whether a recorded version is one this build cannot read. */
export function isNewerThanBuild(format: StoreFormat, version: number): boolean {
  return version > FORMAT_VERSIONS[format];
}
