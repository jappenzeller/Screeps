import { SpawnCandidate } from "../../src/spawning/utilitySpawning";

// Re-export for use in test files
export type { SpawnCandidate };

/**
 * Invariant: A rule that must ALWAYS hold true
 * Returns null if invariant holds, error message if violated
 */
export type Invariant = (
  state: TestColonyState,
  candidate: SpawnCandidate | null
) => string | null;

/**
 * Colony state for testing (mirrors ColonyState from utilitySpawning.ts)
 */
export interface TestColonyState {
  rcl: number;
  energyAvailable: number;
  energyCapacity: number;
  energyStored: number;
  energyIncome: number;
  energyIncomeMax: number;
  counts: Record<string, number>;
  targets: Record<string, number>;
  homeThreats: number;
  remoteThreatsByRoom: Record<string, number>;
  constructionSites: number;
  remoteRooms: string[];
  dyingSoon: Record<string, number>;
}

/**
 * Critical invariants that must never be violated
 */
export const CRITICAL_INVARIANTS: Record<string, Invariant> = {
  /**
   * INV-001: If 0 harvesters and enough energy, MUST spawn harvester
   */
  "harvester-priority-zero": (state, candidate) => {
    const hasNoHarvesters = (state.counts.HARVESTER || 0) === 0;
    const canAffordMinimal = state.energyAvailable >= 200;

    if (hasNoHarvesters && canAffordMinimal) {
      if (!candidate) {
        return "No spawn candidate when 0 harvesters and 200+ energy";
      }
      if (candidate.role !== "HARVESTER") {
        return `Spawning ${candidate.role} instead of HARVESTER with 0 harvesters`;
      }
    }
    return null;
  },

  /**
   * INV-002: If 0 haulers but harvesters exist, spawn hauler before non-economy roles
   */
  "hauler-priority-after-harvester": (state, candidate) => {
    const hasHarvesters = (state.counts.HARVESTER || 0) > 0;
    const hasNoHaulers = (state.counts.HAULER || 0) === 0;
    const canAfford = state.energyAvailable >= 100;

    if (hasHarvesters && hasNoHaulers && canAfford) {
      if (!candidate) {
        return "No spawn candidate when harvesters exist but 0 haulers";
      }
      const nonEconomyRoles = ["UPGRADER", "BUILDER", "SCOUT", "RESERVER"];
      if (nonEconomyRoles.includes(candidate.role)) {
        return `Spawning ${candidate.role} instead of HAULER with 0 haulers`;
      }
    }
    return null;
  },

  /**
   * INV-003: Never spawn remote roles if home economy is dead
   */
  "no-remote-without-economy": (state, candidate) => {
    const homeEconomyDead =
      (state.counts.HARVESTER || 0) === 0 || (state.counts.HAULER || 0) === 0;

    if (homeEconomyDead && candidate) {
      const remoteRoles = ["REMOTE_MINER", "REMOTE_HAULER", "RESERVER", "REMOTE_DEFENDER"];
      if (remoteRoles.includes(candidate.role)) {
        return `Spawning remote role ${candidate.role} with dead home economy`;
      }
    }
    return null;
  },

  /**
   * INV-004: Never spawn defender if no threats
   */
  "no-defender-without-threat": (state, candidate) => {
    const noThreats = state.homeThreats === 0;

    if (noThreats && candidate?.role === "DEFENDER") {
      return "Spawning DEFENDER with 0 home threats";
    }
    return null;
  },

  /**
   * INV-005: Never spawn builder if no construction sites
   */
  "no-builder-without-sites": (state, candidate) => {
    const noSites = state.constructionSites === 0;

    if (noSites && candidate?.role === "BUILDER") {
      return "Spawning BUILDER with 0 construction sites";
    }
    return null;
  },

  /**
   * INV-006: Body cost must not exceed available energy
   */
  "body-affordable": (state, candidate) => {
    if (!candidate) return null;

    const BODYPART_COST: Record<string, number> = {
      move: 50,
      work: 100,
      carry: 50,
      attack: 80,
      ranged_attack: 150,
      heal: 250,
      claim: 600,
      tough: 10,
    };

    const cost = candidate.body.reduce((sum, part) => sum + (BODYPART_COST[part] || 0), 0);

    if (cost > state.energyAvailable) {
      return `Body cost ${cost} exceeds available energy ${state.energyAvailable}`;
    }
    return null;
  },

  /**
   * INV-007: Scout should have lowest priority among all roles
   */
  "scout-lowest-priority": (state, candidate) => {
    const hasHarvesters = (state.counts.HARVESTER || 0) > 0;
    const hasHaulers = (state.counts.HAULER || 0) > 0;
    const needsEssential =
      (state.targets.HARVESTER || 0) > (state.counts.HARVESTER || 0) ||
      (state.targets.HAULER || 0) > (state.counts.HAULER || 0);

    // If we're missing essential roles, should never spawn scout
    if (candidate?.role === "SCOUT" && (!hasHarvesters || !hasHaulers) && needsEssential) {
      return "Spawning SCOUT when essential roles are under target";
    }
    return null;
  },

  /**
   * INV-008: Remote miner only at RCL 4+
   */
  "remote-miner-rcl-gate": (state, candidate) => {
    if (state.rcl < 4 && candidate?.role === "REMOTE_MINER") {
      return `Spawning REMOTE_MINER at RCL ${state.rcl} (requires RCL 4)`;
    }
    return null;
  },

  /**
   * INV-009: Remote hauler only at RCL 4+
   */
  "remote-hauler-rcl-gate": (state, candidate) => {
    if (state.rcl < 4 && candidate?.role === "REMOTE_HAULER") {
      return `Spawning REMOTE_HAULER at RCL ${state.rcl} (requires RCL 4)`;
    }
    return null;
  },

  /**
   * INV-010: Reserver only at RCL 4+
   */
  "reserver-rcl-gate": (state, candidate) => {
    if (state.rcl < 4 && candidate?.role === "RESERVER") {
      return `Spawning RESERVER at RCL ${state.rcl} (requires RCL 4)`;
    }
    return null;
  },
};

/**
 * Warning-level invariants (non-critical but suspicious)
 */
export const WARNING_INVARIANTS: Record<string, Invariant> = {
  /**
   * WARN-001: Utility scores should reflect priority
   */
  "utility-reflects-priority": (state, candidate) => {
    if (!candidate) return null;

    const hasNoHarvesters = (state.counts.HARVESTER || 0) === 0;
    if (hasNoHarvesters && candidate.role === "HARVESTER" && candidate.utility < 1000) {
      return `Harvester utility suspiciously low (${candidate.utility}) with 0 harvesters`;
    }
    return null;
  },

  /**
   * WARN-002: Very high utility values might indicate overflow
   */
  "utility-not-infinite": (state, candidate) => {
    if (!candidate) return null;

    if (candidate.utility > 1000000 || !isFinite(candidate.utility)) {
      return `Utility value ${candidate.utility} is suspiciously high or infinite`;
    }
    return null;
  },
};
