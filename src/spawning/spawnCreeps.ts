/**
 * Simple spawning - one file, predictable creep counts.
 * No complex strategy, just spawn what's needed based on room state.
 */

interface CreepTarget {
  role: string;
  body: BodyPartConstant[];
  count: number;
  memory?: Partial<CreepMemory>;
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
      const memory: CreepMemory = {
        role: target.role,
        room: room.name,
        ...target.memory,
      } as CreepMemory;

      const result = spawn.spawnCreep(target.body, name, { memory });
      if (result === OK) {
        console.log(`[${room.name}] Spawning ${target.role}${target.memory?.targetRoom ? ` -> ${target.memory.targetRoom}` : ""}`);
      }
      return; // One spawn attempt per tick
    }
  }
}

function getTargets(rcl: number, energy: number, room: Room): CreepTarget[] {
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

  // Defenders: spawn if hostiles present
  const hostiles = room.find(FIND_HOSTILE_CREEPS);
  if (hostiles.length > 0) {
    const defenderBody = scaleBody([TOUGH, ATTACK, MOVE, MOVE], energy, 3);
    targets.push({ role: "DEFENDER", body: defenderBody, count: Math.min(2, hostiles.length) });
  }

  // RCL 4+: Remote mining and scouting
  if (rcl >= 4) {
    // Scout: 1 if any adjacent room needs intel
    const scoutNeeded = needsScout(room.name);
    if (scoutNeeded) {
      targets.push({ role: "SCOUT", body: [MOVE], count: 1 });
    }

    // Remote miners: 1 per remote source
    const remoteTargets = getRemoteMiningTargets(room.name);
    for (const target of remoteTargets) {
      const remoteMinerBody: BodyPartConstant[] = [WORK, WORK, WORK, WORK, WORK, CARRY, MOVE, MOVE, MOVE];
      const currentMiners = countRemoteMiners(room.name, target.roomName, target.sourceId);

      if (currentMiners < 1) {
        targets.push({
          role: "REMOTE_MINER",
          body: remoteMinerBody,
          count: currentMiners + 1, // Add one more
          memory: { targetRoom: target.roomName, sourceId: target.sourceId },
        });
      }
    }

    // Remote haulers: 2 per remote room
    const remoteRooms = getRemoteRooms(room.name);
    for (const targetRoom of remoteRooms) {
      const remoteHaulerBody: BodyPartConstant[] = [
        CARRY, CARRY, CARRY, CARRY, CARRY, CARRY,
        MOVE, MOVE, MOVE, MOVE, MOVE, MOVE,
      ];
      const currentHaulers = countRemoteHaulers(room.name, targetRoom);

      if (currentHaulers < 2) {
        targets.push({
          role: "REMOTE_HAULER",
          body: remoteHaulerBody,
          count: currentHaulers + 1,
          memory: { targetRoom },
        });
      }
    }

    // Reservers: 1 per 2 remote rooms, prioritize rooms needing reservation
    const roomsNeedingReservation = remoteRooms.filter((targetRoom) => {
      const intel = Memory.rooms?.[targetRoom];
      if (!intel) return true;
      const reservation = intel.controller?.reservation;
      // Need reserver if no reservation or reservation expiring soon
      return !reservation || reservation.ticksToEnd < 1000;
    });

    if (roomsNeedingReservation.length > 0) {
      const reserverBody: BodyPartConstant[] = [CLAIM, CLAIM, MOVE, MOVE]; // 1300 energy
      const currentReservers = countReservers(room.name);
      const neededReservers = Math.ceil(remoteRooms.length / 2);

      if (currentReservers < neededReservers && energy >= 1300) {
        // Assign to first room needing reservation
        targets.push({
          role: "RESERVER",
          body: reserverBody,
          count: currentReservers + 1,
          memory: { targetRoom: roomsNeedingReservation[0] },
        });
      }
    }
  }

  return targets;
}

function needsScout(homeRoom: string): boolean {
  const exits = Game.map.describeExits(homeRoom);
  if (!exits) return false;

  for (const dir in exits) {
    const roomName = exits[dir as ExitKey];
    if (!roomName) continue;

    const intel = Memory.rooms?.[roomName];
    const lastScan = intel?.lastScan || 0;

    if (Game.time - lastScan > 2000) {
      return true;
    }
  }
  return false;
}

interface RemoteTarget {
  roomName: string;
  sourceId: Id<Source>;
}

function getRemoteMiningTargets(homeRoom: string): RemoteTarget[] {
  const targets: RemoteTarget[] = [];
  const exits = Game.map.describeExits(homeRoom);
  if (!exits) return targets;

  for (const dir in exits) {
    const roomName = exits[dir as ExitKey];
    if (!roomName) continue;

    const intel = Memory.rooms?.[roomName];
    if (!intel?.sources || intel.sources.length === 0) continue;

    // Skip rooms with hostiles, keepers, or invader cores
    if (intel.hostiles && intel.hostiles > 0) continue;
    if (intel.hasKeepers) continue;
    if (intel.hasInvaderCore) continue;

    // Skip owned or reserved rooms (not by us)
    if (intel.controller?.owner && intel.controller.owner !== "YOUR_USERNAME") continue;

    for (const sourceId of intel.sources) {
      targets.push({ roomName, sourceId: sourceId as Id<Source> });
    }
  }

  return targets;
}

function countRemoteMiners(homeRoom: string, targetRoom: string, sourceId: Id<Source>): number {
  let count = 0;
  for (const name in Game.creeps) {
    const creep = Game.creeps[name];
    if (
      creep.memory.role === "REMOTE_MINER" &&
      creep.memory.room === homeRoom &&
      creep.memory.targetRoom === targetRoom &&
      creep.memory.sourceId === sourceId
    ) {
      count++;
    }
  }
  return count;
}

function getRemoteRooms(homeRoom: string): string[] {
  const targets = getRemoteMiningTargets(homeRoom);
  const rooms = new Set<string>();
  for (const target of targets) {
    rooms.add(target.roomName);
  }
  return Array.from(rooms);
}

function countRemoteHaulers(homeRoom: string, targetRoom: string): number {
  let count = 0;
  for (const name in Game.creeps) {
    const creep = Game.creeps[name];
    if (
      creep.memory.role === "REMOTE_HAULER" &&
      creep.memory.room === homeRoom &&
      creep.memory.targetRoom === targetRoom
    ) {
      count++;
    }
  }
  return count;
}

function countReservers(homeRoom: string): number {
  let count = 0;
  for (const name in Game.creeps) {
    const creep = Game.creeps[name];
    if (
      creep.memory.role === "RESERVER" &&
      creep.memory.room === homeRoom
    ) {
      count++;
    }
  }
  return count;
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
