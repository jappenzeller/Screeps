import { CONFIG, Role } from "../config";
import { ColonyStateManager, CachedColonyState } from "./ColonyState";

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

    // Harvesters: 1 per source (with containers) or 2 per source (without)
    if (role === "HARVESTER") {
      const sourceCount = state.sources.length;
      const hasContainers = state.structures.containers.length > 0;
      const needed = hasContainers ? sourceCount : sourceCount * 2;
      return count < needed;
    }

    // Haulers: 2 if containers exist, 0 otherwise
    if (role === "HAULER") {
      if (state.structures.containers.length === 0) return false;
      return count < 2;
    }

    // Upgraders: use config min, require at least one harvester
    if (role === "UPGRADER") {
      if (this.getCreepCount("HARVESTER") === 0) return false;
      const min = CONFIG.MIN_CREEPS.UPGRADER ?? 2;
      return count < min;
    }

    // Builders: 1-2 if construction sites exist, 0 otherwise
    if (role === "BUILDER") {
      const siteCount = state.constructionSites.length;
      if (siteCount === 0) return false;
      const needed = siteCount > 5 ? 2 : 1;
      return count < needed;
    }

    // Other roles: use CONFIG.MIN_CREEPS directly
    const min = CONFIG.MIN_CREEPS[role as keyof typeof CONFIG.MIN_CREEPS] ?? 0;
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
