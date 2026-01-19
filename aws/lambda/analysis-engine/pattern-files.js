/**
 * Pattern to File Mapping Module
 * Maps detected patterns to relevant source files for code-aware analysis
 */

export const PATTERN_FILE_MAPPINGS = [
  {
    pattern: "ENERGY_STARVATION",
    files: [
      "src/creeps/Harvester.ts",
      "src/creeps/Hauler.ts",
      "src/structures/LinkManager.ts",
      "src/spawning/spawnCreeps.ts",
      "src/core/ColonyManager.ts",
    ],
    searchTerms: ["energy", "storage", "harvest", "withdraw"],
  },
  {
    pattern: "HAULER_SHORTAGE",
    files: [
      "src/spawning/spawnCreeps.ts",
      "src/creeps/Hauler.ts",
      "src/core/ColonyManager.ts",
    ],
    searchTerms: ["HAULER", "haulerCount", "getTargets", "needsCreep"],
  },
  {
    pattern: "NO_UPGRADERS",
    files: [
      "src/spawning/spawnCreeps.ts",
      "src/creeps/Upgrader.ts",
      "src/core/ColonyManager.ts",
    ],
    searchTerms: ["UPGRADER", "upgraderCount", "upgradeController"],
  },
  {
    pattern: "CPU_BUCKET_LOW",
    files: [
      "src/main.ts",
      "src/utils/Logger.ts",
      "src/core/ColonyManager.ts",
      "src/config.ts",
    ],
    searchTerms: ["cpu", "bucket", "getUsed"],
  },
  {
    pattern: "REMOTE_HAULER_SHORTAGE",
    files: [
      "src/spawning/spawnCreeps.ts",
      "src/creeps/RemoteHauler.ts",
      "src/creeps/RemoteMiner.ts",
    ],
    searchTerms: ["REMOTE_HAULER", "remoteHauler", "targetRoom"],
  },
  {
    pattern: "RCL_STALL",
    files: [
      "src/creeps/Upgrader.ts",
      "src/structures/LinkManager.ts",
      "src/spawning/spawnCreeps.ts",
    ],
    searchTerms: ["upgrade", "controller", "UPGRADER"],
  },
  {
    pattern: "ACTIVE_THREAT",
    files: [
      "src/defense/AutoSafeMode.ts",
      "src/structures/TowerManager.ts",
      "src/spawning/spawnCreeps.ts",
    ],
    searchTerms: ["hostile", "defense", "tower", "DEFENDER"],
  },
  {
    pattern: "TRAFFIC_BOTTLENECK",
    files: [
      "src/core/TrafficMonitor.ts",
      "src/core/SmartRoadPlanner.ts",
      "src/utils/movement.ts",
    ],
    searchTerms: ["traffic", "road", "moveTo"],
  },
  {
    pattern: "STORAGE_FULL",
    files: [
      "src/creeps/Upgrader.ts",
      "src/spawning/spawnCreeps.ts",
      "src/core/ColonyManager.ts",
    ],
    searchTerms: ["storage", "UPGRADER", "energy"],
  },
  {
    pattern: "NO_MINERS",
    files: [
      "src/spawning/spawnCreeps.ts",
      "src/creeps/Harvester.ts",
      "src/core/ColonyManager.ts",
    ],
    searchTerms: ["HARVESTER", "harvest", "source", "spawn"],
  },
];

/**
 * Get relevant files for detected patterns
 */
export function getRelevantFiles(patterns) {
  const files = new Set();

  for (const pattern of patterns) {
    // Extract pattern name (may be object with id field or string)
    const patternName = typeof pattern === "string"
      ? pattern.split(":")[0].trim()
      : pattern.id || pattern;

    const mapping = PATTERN_FILE_MAPPINGS.find((m) => m.pattern === patternName);
    if (mapping) {
      mapping.files.forEach((f) => files.add(f));
    }
  }

  // Always include core files for context
  files.add("src/main.ts");
  files.add("src/config.ts");

  return Array.from(files);
}

/**
 * Get search terms for patterns
 */
export function getSearchTerms(patterns) {
  const terms = new Set();

  for (const pattern of patterns) {
    const patternName = typeof pattern === "string"
      ? pattern.split(":")[0].trim()
      : pattern.id || pattern;

    const mapping = PATTERN_FILE_MAPPINGS.find((m) => m.pattern === patternName);
    if (mapping?.searchTerms) {
      mapping.searchTerms.forEach((t) => terms.add(t));
    }
  }

  return Array.from(terms);
}

/**
 * Get the most relevant files (top N by pattern match count)
 */
export function getMostRelevantFiles(patterns, maxFiles = 6) {
  const fileCounts = new Map();

  for (const pattern of patterns) {
    const patternName = typeof pattern === "string"
      ? pattern.split(":")[0].trim()
      : pattern.id || pattern;

    const mapping = PATTERN_FILE_MAPPINGS.find((m) => m.pattern === patternName);
    if (mapping) {
      for (const file of mapping.files) {
        fileCounts.set(file, (fileCounts.get(file) || 0) + 1);
      }
    }
  }

  // Sort by count (most relevant first)
  const sorted = Array.from(fileCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxFiles)
    .map(([file]) => file);

  // Always include main.ts and config.ts
  if (!sorted.includes("src/main.ts")) sorted.push("src/main.ts");
  if (!sorted.includes("src/config.ts")) sorted.push("src/config.ts");

  return sorted;
}
