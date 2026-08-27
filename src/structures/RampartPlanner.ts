import { logger } from "../utils/Logger";

/**
 * RampartPlanner - Ramparts the structures that lose the room if they die.
 *
 * Deliberately NOT a perimeter/min-cut planner. A full wall line costs hundreds of
 * ramparts and a permanent repair-energy bill, which an energy-starved room cannot
 * pay. Covering spawns, towers, storage and terminal costs ~10 ramparts per room and
 * is what stops a small raid from one-shotting a spawn before towers respond.
 *
 * Runs independently of ConstructionCoordinator: that gate requires every
 * higher-priority structure type to be complete first, which would block ramparts in
 * any room still filling out extensions. Defense should not wait on that.
 */

/** Structures worth a rampart, most critical first. */
const RAMPART_TARGETS: StructureConstant[] = [
  STRUCTURE_SPAWN,
  STRUCTURE_TOWER,
  STRUCTURE_STORAGE,
  STRUCTURE_TERMINAL,
];

/** Cap on simultaneous rampart sites so builders are not pulled off economy work. */
const MAX_CONCURRENT_SITES = 3;

export class RampartPlanner {
  constructor(private room: Room) {}

  run(): void {
    const controller = this.room.controller;
    if (!controller || !controller.my || controller.level < 2) return;

    const maxRamparts = CONTROLLER_STRUCTURES[STRUCTURE_RAMPART][controller.level] ?? 0;
    if (maxRamparts === 0) return;

    const myStructures = this.room.find(FIND_MY_STRUCTURES);
    const rampartSites = this.room.find(FIND_CONSTRUCTION_SITES, {
      filter: (s) => s.structureType === STRUCTURE_RAMPART,
    });

    const existing = myStructures.filter((s) => s.structureType === STRUCTURE_RAMPART);

    let budget = Math.min(
      MAX_CONCURRENT_SITES - rampartSites.length,
      maxRamparts - existing.length - rampartSites.length
    );
    if (budget <= 0) return;

    const covered = new Set<string>();
    for (const r of existing) covered.add(`${r.pos.x}:${r.pos.y}`);
    for (const s of rampartSites) covered.add(`${s.pos.x}:${s.pos.y}`);

    for (const target of this.uncoveredTargets(myStructures, covered)) {
      if (budget <= 0) break;

      const result = this.room.createConstructionSite(target.pos, STRUCTURE_RAMPART);
      if (result === OK) {
        covered.add(`${target.pos.x}:${target.pos.y}`);
        budget--;
        logger.info(
          "RampartPlanner",
          `${this.room.name}: rampart over ${target.structureType} at ${target.pos.x},${target.pos.y}`
        );
      } else if (result === ERR_FULL) {
        // Global 100-site cap reached - nothing more to do this tick.
        return;
      } else {
        logger.warn(
          "RampartPlanner",
          `${this.room.name}: rampart at ${target.pos.x},${target.pos.y} failed (${result})`
        );
        return;
      }
    }
  }

  /** Critical structures with no rampart on their tile, most critical type first. */
  private uncoveredTargets(structures: AnyOwnedStructure[], covered: Set<string>): AnyOwnedStructure[] {
    const targets: AnyOwnedStructure[] = [];

    for (const type of RAMPART_TARGETS) {
      for (const s of structures) {
        if (s.structureType !== type) continue;
        if (covered.has(`${s.pos.x}:${s.pos.y}`)) continue;
        targets.push(s);
      }
    }

    return targets;
  }

  /** Human-readable coverage report for the ramparts() console command. */
  getStatus(): string {
    const controller = this.room.controller;
    if (!controller || !controller.my) return `${this.room.name}: not owned`;

    const myStructures = this.room.find(FIND_MY_STRUCTURES);
    const existing = myStructures.filter((s) => s.structureType === STRUCTURE_RAMPART);
    const sites = this.room.find(FIND_CONSTRUCTION_SITES, {
      filter: (s) => s.structureType === STRUCTURE_RAMPART,
    });

    const covered = new Set<string>();
    for (const r of existing) covered.add(`${r.pos.x}:${r.pos.y}`);
    for (const s of sites) covered.add(`${s.pos.x}:${s.pos.y}`);

    const lines: string[] = [];
    const max = CONTROLLER_STRUCTURES[STRUCTURE_RAMPART][controller.level] ?? 0;
    lines.push(`${this.room.name} (RCL ${controller.level}): ${existing.length}/${max} ramparts, ${sites.length} sites`);

    for (const type of RAMPART_TARGETS) {
      const of_type = myStructures.filter((s) => s.structureType === type);
      if (of_type.length === 0) continue;
      const done = of_type.filter((s) => covered.has(`${s.pos.x}:${s.pos.y}`)).length;
      lines.push(`  ${type}: ${done}/${of_type.length} protected`);
    }

    if (existing.length > 0) {
      const weakest = existing.reduce((a, b) => (a.hits < b.hits ? a : b));
      lines.push(`  weakest rampart: ${weakest.hits} hits`);
    }

    return lines.join("\n");
  }
}
