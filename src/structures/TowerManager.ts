import { logger } from "../utils/Logger";
import { ColonyStateManager, ThreatLevel, CachedColonyState } from "../core/ColonyState";

/**
 * TowerManager - Controls tower behavior for a room
 * Uses ColonyState for cached hostiles to reduce CPU
 * Priority: Attack hostiles > Heal creeps > Repair structures
 */
export class TowerManager {
  private towers: StructureTower[] = [];
  private state: CachedColonyState | null = null;
  private lastRepairSearch: number = 0;
  private cachedRepairTarget: Structure | null = null;

  constructor(private room: Room) {
    // Get state from ColonyStateManager (uses cached structures)
    this.state = ColonyStateManager.getState(room.name);

    if (this.state) {
      this.towers = this.state.structures.towers;
    } else {
      // Fallback if no state
      this.towers = room.find(FIND_MY_STRUCTURES, {
        filter: (s) => s.structureType === STRUCTURE_TOWER,
      }) as StructureTower[];
    }
  }

  run(): void {
    if (this.towers.length === 0) return;

    // Priority 1: Attack hostiles (using cached threat data)
    if (this.state && this.state.threat.level > ThreatLevel.NONE) {
      const target = this.selectAttackTarget(this.state.threat.hostiles);
      if (target) {
        for (const tower of this.towers) {
          if (tower.store[RESOURCE_ENERGY] >= 10) {
            tower.attack(target);
          }
        }
        return;
      }
    }

    // Priority 2: Heal damaged creeps (using cached creeps)
    const damagedCreeps = this.state
      ? this.state.creeps.all.filter((c) => c.hits < c.hitsMax)
      : this.room.find(FIND_MY_CREEPS, { filter: (c) => c.hits < c.hitsMax });

    if (damagedCreeps.length > 0) {
      const mostDamaged = damagedCreeps.reduce((a, b) =>
        a.hits / a.hitsMax < b.hits / b.hitsMax ? a : b
      );
      for (const tower of this.towers) {
        if (tower.store[RESOURCE_ENERGY] >= 10) {
          tower.heal(mostDamaged);
        }
      }
      return;
    }

    // Priority 3: Repair structures (only if energy is sufficient)
    const minTowerEnergy = Math.min(...this.towers.map((t) => t.store[RESOURCE_ENERGY]));
    if (minTowerEnergy < 500) return;

    // Only search for repair targets every 3 ticks to save CPU
    const damaged = this.findRepairTarget();
    if (damaged) {
      // Only use one tower for repairs
      const tower = this.towers[0];
      if (tower.store[RESOURCE_ENERGY] >= 10) {
        tower.repair(damaged);
      }
    }
  }

  /**
   * Select best attack target using cached threat data
   * Priority: Healers > Ranged > Melee > Others
   */
  private selectAttackTarget(hostiles: Creep[]): Creep | null {
    if (hostiles.length === 0) return null;

    // Sort by threat level
    const sorted = hostiles.sort((a, b) => {
      const threatA = this.getThreatLevel(a);
      const threatB = this.getThreatLevel(b);
      return threatB - threatA;
    });

    return sorted[0] || null;
  }

  private getThreatLevel(creep: Creep): number {
    let threat = 0;
    // Healers are highest priority - they sustain attacks
    threat += creep.getActiveBodyparts(HEAL) * 100;
    // Ranged can hit from distance
    threat += creep.getActiveBodyparts(RANGED_ATTACK) * 50;
    // Melee attackers
    threat += creep.getActiveBodyparts(ATTACK) * 30;
    // Work parts can dismantle structures
    threat += creep.getActiveBodyparts(WORK) * 20;
    // Claim parts can attack controllers
    threat += creep.getActiveBodyparts(CLAIM) * 40;
    return threat;
  }

  /**
   * Find structure to repair
   * Uses caching to reduce CPU - only searches every 3 ticks
   */
  private findRepairTarget(): Structure | null {
    // Use cached target if still valid and recent
    if (this.cachedRepairTarget && Game.time - this.lastRepairSearch < 3) {
      // Verify target still needs repair
      if (this.cachedRepairTarget.hits < this.cachedRepairTarget.hitsMax * 0.75) {
        return this.cachedRepairTarget;
      }
    }

    this.lastRepairSearch = Game.time;

    // Critical containers and roads (below 50%)
    const criticalStructure = this.room.find(FIND_STRUCTURES, {
      filter: (s) => {
        if (s.structureType === STRUCTURE_WALL || s.structureType === STRUCTURE_RAMPART) {
          return false;
        }
        return s.hits < s.hitsMax * 0.5;
      },
    })[0];

    if (criticalStructure) {
      this.cachedRepairTarget = criticalStructure;
      return criticalStructure;
    }

    // Low ramparts (below 10k)
    const lowRampart = this.room.find(FIND_MY_STRUCTURES, {
      filter: (s) => s.structureType === STRUCTURE_RAMPART && s.hits < 10000,
    })[0];

    if (lowRampart) {
      this.cachedRepairTarget = lowRampart;
      return lowRampart;
    }

    // Low walls (below 10k)
    const lowWall = this.room.find(FIND_STRUCTURES, {
      filter: (s) => s.structureType === STRUCTURE_WALL && s.hits < 10000,
    })[0];

    if (lowWall) {
      this.cachedRepairTarget = lowWall;
      return lowWall;
    }

    // General repair: anything below 75%
    const damagedStructure = this.room.find(FIND_STRUCTURES, {
      filter: (s) => {
        if (s.structureType === STRUCTURE_WALL || s.structureType === STRUCTURE_RAMPART) {
          return false;
        }
        return s.hits < s.hitsMax * 0.75;
      },
    })[0];

    this.cachedRepairTarget = damagedStructure || null;
    return damagedStructure || null;
  }
}
