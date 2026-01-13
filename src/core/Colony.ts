import { CONFIG, Role } from "../config";
import { ColonyStateManager, CachedColonyState } from "./ColonyState";
import { StrategicCoordinator } from "./StrategicCoordinator";

// Re-export the CachedColonyState type as ColonyState for backward compatibility
export type ColonyState = CachedColonyState;

export class Colony {
  constructor(public readonly roomName: string) {}

  get room(): Room | undefined {
    return Game.rooms[this.roomName];
  }

  /**
   * Get the colony state using ColonyStateManager
   * This replaces the old scan() method that recalculated everything each tick
   */
  scan(): CachedColonyState | null {
    return ColonyStateManager.getState(this.roomName);
  }

  getState(): CachedColonyState | null {
    return ColonyStateManager.getState(this.roomName);
  }

  getCreepCount(role: string): number {
    const state = this.getState();
    return state?.creeps.byRole[role]?.length ?? 0;
  }

  needsCreep(role: Role): boolean {
    const state = this.getState();
    if (!state) return false;

    const count = this.getCreepCount(role);
    const min = CONFIG.MIN_CREEPS[role as keyof typeof CONFIG.MIN_CREEPS] ?? 0;

    // Harvesters: need 1 per source (static miner with container)
    // or 2 per source early game (travel time) capped at config min
    if (role === "HARVESTER") {
      const sourceCount = state.sources.length;
      const hasContainers = state.structures.containers.length > 0;
      // With containers: 1 per source (static miner)
      // Without: 2 per source (travel time) but capped at min config
      const needed = hasContainers ? sourceCount : Math.min(sourceCount * 2, min);
      return count < needed;
    }

    // Upgraders: dynamic scaling based on energy budget and storage levels
    if (role === "UPGRADER") {
      // Need at least one harvester to bring energy
      if (this.getCreepCount("HARVESTER") === 0) return false;

      // Use StrategicCoordinator's dynamic target (factors in budget allocations and energy surplus)
      const strategicState = StrategicCoordinator.getState(this.roomName);
      const targetUpgraders = strategicState?.workforce.targetCreeps.UPGRADER ?? min;
      const maxUpgraders = CONFIG.MAX_CREEPS.UPGRADER || 4;
      return count < Math.min(targetUpgraders, maxUpgraders);
    }

    // Builders: dynamic scaling based on construction sites + energy surplus
    if (role === "BUILDER") {
      const hasSites = state.constructionSites.length > 0;
      if (!hasSites) return false;

      // Use StrategicCoordinator's dynamic target (factors in sites, budget, energy surplus)
      const strategicState = StrategicCoordinator.getState(this.roomName);
      const targetBuilders = strategicState?.workforce.targetCreeps.BUILDER ?? 1;
      const maxBuilders = CONFIG.MAX_CREEPS.BUILDER || 3;
      return count < Math.min(targetBuilders, maxBuilders);
    }

    // Haulers: only needed later when we have containers
    if (role === "HAULER") {
      return count < min && state.structures.containers.length > 0;
    }

    return count < min;
  }

  drawVisuals(): void {
    const state = this.getState();
    if (!CONFIG.VISUALS.ENABLED || !state) return;

    const room = state.room;

    // Draw creep roles with distinct abbreviations
    if (CONFIG.VISUALS.SHOW_ROLES) {
      const roleLabels: Record<string, string> = {
        HARVESTER: "Hv",
        HAULER: "Hl",
        UPGRADER: "Up",
        BUILDER: "Bd",
        DEFENDER: "Df",
        SCOUT: "Sc",
        REMOTE_MINER: "Rm",
        RESERVER: "Rs",
        CLAIMER: "Cl",
      };
      for (const creep of state.creeps.all) {
        const label = roleLabels[creep.memory.role] ?? creep.memory.role.charAt(0);
        room.visual.text(label, creep.pos.x, creep.pos.y - 0.5, {
          font: 0.4,
          opacity: 0.7,
        });
      }
    }

    // Draw source assignments
    for (const assignment of state.sourceAssignments) {
      const source = Game.getObjectById(assignment.sourceId);
      if (!source) continue;

      const assigned = assignment.creepName ? 1 : 0;
      const containerIcon = assignment.hasContainer ? "📦" : "";
      room.visual.text(`${assigned}${containerIcon}`, source.pos.x, source.pos.y - 0.5, {
        font: 0.5,
        color: "#ffff00",
      });
    }

    // Draw emergency state if active
    if (state.emergency.isEmergency) {
      room.visual.text("⚠️ EMERGENCY", 25, 2, {
        font: 1,
        color: "#ff0000",
        align: "center",
      });
    }
  }
}
