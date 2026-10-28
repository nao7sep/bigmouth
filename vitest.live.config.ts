import { configDefaults, defineConfig } from "vitest/config";

import base from "./vitest.config";

// The live lane: the real Anthropic API behind the AI handlers, run only by npm
// run test:full. The ordinary run excludes tests/live explicitly, since its main
// project otherwise takes everything the renderer project does not.
// Files run one at a time because they spend money and wait on the network.
export default defineConfig({
  resolve: base.resolve,
  test: {
    environment: "node",
    include: ["tests/live/**/*.test.ts"],
    exclude: configDefaults.exclude,
    setupFiles: ["tests/main/setup.ts"],
    fileParallelism: false,
    // Tests carry no timeouts; the provider's own deadlines bound each call.
    testTimeout: 0,
    hookTimeout: 0,
  },
});
