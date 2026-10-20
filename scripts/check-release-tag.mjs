// check-release-tag: fails unless RELEASE_TAG is "v" plus package.json's
// version. Run by the release workflow as `npm run check:release-tag`, so a tag
// can only release the version the source says it is.

import { readFile } from "node:fs/promises";

const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const expected = `v${packageJson.version}`;
const actual = process.env.RELEASE_TAG;

if (actual !== expected) {
  throw new Error(
    `Release tag must match package.json: expected ${expected}, received ${actual ?? "nothing"}.`,
  );
}
