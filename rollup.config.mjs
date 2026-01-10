import clear from "rollup-plugin-clear";
import screeps from "rollup-plugin-screeps";
import typescript from "rollup-plugin-typescript2";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

let cfg;
const dest = process.env.DEST;

if (!dest) {
  console.log("No destination specified - building to dist/ only");
} else if (dest === "main" || dest === "sim") {
  const screepsConfig = require("./screeps.json");
  cfg = screepsConfig[dest];
  if (!cfg) {
    throw new Error(`No configuration found for destination: ${dest}`);
  }
} else {
  throw new Error(`Invalid destination: ${dest}`);
}

export default {
  input: "src/main.ts",
  output: {
    file: "dist/main.js",
    format: "cjs",
    sourcemap: true,
  },
  plugins: [
    clear({ targets: ["dist"] }),
    typescript({ tsconfig: "./tsconfig.json" }),
    screeps({ config: cfg, dryRun: cfg == null }),
  ],
};
