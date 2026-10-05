// The format version of every store BigMouth writes (store-recovery-conventions).
// No imports: the records reader's worker runs this file from source.

export const FORMAT_VERSIONS = {
  /** A post's `.md` file, in its front matter. */
  postFile: 1,
  /** `posts/index.json`. */
  postIndex: 1,
  /** An asset folder's `meta.json`. */
  assetMeta: 1,
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

/** Whether a recorded version is one this build cannot read. */
export function isNewerThanBuild(format: StoreFormat, version: number): boolean {
  return version > FORMAT_VERSIONS[format];
}
