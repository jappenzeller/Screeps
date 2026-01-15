/**
 * Simple spawning - one file, predictable creep counts.
 * No complex strategy, just spawn what's needed based on room state.
 */

interface CreepTarget {
  role: string;
  body: BodyPartConstant[];
  count: number;
}

export function spawnCreeps(room: Room): void {
  const spawn = room.find(FIND_MY_SPAWNS).find((s) => !s.spawning);
  if (!spawn) return;

  const rcl = room.controller?.level ?? 1;
  const energy = room.energyCapacityAvailable;
  const creeps = Object.values(Game.creeps).filter((c) => c.memory.room === room.name);

  // Count by role
  const countRole = (role: string) => creeps.filter((c) => c.memory.role === role).length;

  // Define what we need based on RCL
  const targets = getTargets(rcl, energy, room);

  // Spawn first thing that's under target
  for (const target of targets) {
    if (countRole(target.role) < target.count) {
      const name = `${target.role}_${Game.time}`;
      const result = spawn.spawnCreep(target.body, name, {
        memory: { role: target.role, room: room.name } as CreepMemory,
      });
      if (result === OK) {
        console.log(`[${room.name}] Spawning ${target.role}`);
      }
      return; // One spawn attempt per tick
    }
  }
}

function getTargets(_rcl: number, energy: number, room: Room): CreepTarget[] {
  const targets: CreepTarget[] = [];

  // Scale body to available energy
  const workerBody = scaleBody([WORK, CARRY, MOVE], energy);
  const haulerBody = scaleBody([CARRY, CARRY, MOVE], energy);
  const harvesterBody = scaleBody([WORK, WORK, CARRY, MOVE], energy, 3); // Cap at 6 WORK (3 units)

  // Harvesters: 1 per source
  const sourceCount = room.find(FIND_SOURCES).length;
  targets.push({ role: "HARVESTER", body: harvesterBody, count: sourceCount });

  // Haulers: need them once containers exist
  const containers = room.find(FIND_STRUCTURES, {
    filter: (s) => s.structureType === STRUCTURE_CONTAINER,
  });
  if (containers.length > 0) {
    targets.push({ role: "HAULER", body: haulerBody, count: Math.max(2, sourceCount) });
  }

  // Upgraders: always need some
  const upgraderCount = 3;
  targets.push({ role: "UPGRADER", body: workerBody, count: upgraderCount });

  // Builders: only when construction sites exist
  const sites = room.find(FIND_CONSTRUCTION_SITES).length;
  if (sites > 0) {
    targets.push({ role: "BUILDER", body: workerBody, count: Math.min(2, Math.ceil(sites / 3)) });
  }

  return targets;
}

function scaleBody(
  unit: BodyPartConstant[],
  energy: number,
  maxUnits: number = 10
): BodyPartConstant[] {
  const unitCost = unit.reduce((sum, part) => sum + BODYPART_COST[part], 0);
  const units = Math.min(maxUnits, Math.floor(energy / unitCost));

  const body: BodyPartConstant[] = [];
  for (let i = 0; i < units; i++) {
    body.push(...unit);
  }

  // Ensure we have at least one unit, and it fits in current energy
  if (body.length === 0 || units === 0) {
    return unit;
  }

  return body;
}
