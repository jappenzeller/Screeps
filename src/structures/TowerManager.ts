/**
 * TowerManager - Controls tower behavior for a room
 * Simple implementation: Attack hostiles > Heal creeps > Repair structures
 */
export class TowerManager {
  private towers: StructureTower[] = [];

  constructor(private room: Room) {
    this.towers = room.find(FIND_MY_STRUCTURES, {
      filter: (s) => s.structureType === STRUCTURE_TOWER,
    }) as StructureTower[];
  }

  run(): void {
    if (this.towers.length === 0) return;

    // Priority 1: Attack hostiles
    const hostiles = this.room.find(FIND_HOSTILE_CREEPS);
    if (hostiles.length > 0) {
      const target = this.selectAttackTarget(hostiles);
      if (target) {
        for (const tower of this.towers) {
          if (tower.store[RESOURCE_ENERGY] >= 10) {
            tower.attack(target);
          }
        }
        return;
      }
    }

    // Priority 2: Heal damaged creeps
    const damagedCreeps = this.room.find(FIND_MY_CREEPS, {
      filter: (c) => c.hits < c.hitsMax,
    });

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
    // Skip repairs when economy is dead — preserve tower energy for defense only
    var roomName = this.room.name;
    var towerCreeps = Object.values(Game.creeps).filter(function(c: Creep) {
      return c.memory.room === roomName;
    });
    var hasHarvesters = towerCreeps.some(function(c: Creep) {
      return c.memory.role === 'HARVESTER' || c.memory.role === 'PIONEER';
    });

    if (!hasHarvesters) {
      // Economy dead — only attack hostiles and heal, skip all repairs
      return;
    }

    const minTowerEnergy = Math.min(...this.towers.map((t) => t.store[RESOURCE_ENERGY]));
    if (minTowerEnergy < 500) return;

    // Find something to repair
    const damaged = this.findRepairTarget();
    if (damaged) {
      // Only use one tower for repairs
      const tower = this.towers[0];
      if (tower.store[RESOURCE_ENERGY] >= 10) {
        tower.repair(damaged);
      }
    }
  }

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
    threat += creep.getActiveBodyparts(HEAL) * 100;
    threat += creep.getActiveBodyparts(RANGED_ATTACK) * 50;
    threat += creep.getActiveBodyparts(ATTACK) * 30;
    threat += creep.getActiveBodyparts(WORK) * 20;
    threat += creep.getActiveBodyparts(CLAIM) * 40;
    return threat;
  }

  private findRepairTarget(): Structure | null {
    // Critical structures (below 50%)
    const critical = this.room.find(FIND_STRUCTURES, {
      filter: (s) => {
        if (s.structureType === STRUCTURE_WALL || s.structureType === STRUCTURE_RAMPART) {
          return false;
        }
        return s.hits < s.hitsMax * 0.5;
      },
    })[0];

    if (critical) return critical;

    // Low ramparts (below 10k)
    const lowRampart = this.room.find(FIND_MY_STRUCTURES, {
      filter: (s) => s.structureType === STRUCTURE_RAMPART && s.hits < 10000,
    })[0];

    if (lowRampart) return lowRampart;

    // General repair: anything below 75%
    const damaged = this.room.find(FIND_STRUCTURES, {
      filter: (s) => {
        if (s.structureType === STRUCTURE_WALL || s.structureType === STRUCTURE_RAMPART) {
          return false;
        }
        return s.hits < s.hitsMax * 0.75;
      },
    })[0];

    return damaged || null;
  }
}
