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
    let shouldSpawn = false;

    if (target.memory?.sourceId) {
      // Per-source roles (REMOTE_MINER) - count miners for this specific source
      const sourceCreeps = creeps.filter(
        (c) => c.memory.role === target.role && c.memory.sourceId === target.memory?.sourceId
      ).length;
      shouldSpawn = sourceCreeps < target.count;
    } else if (target.memory?.targetRoom && !target.memory?.sourceId) {
      // Per-room roles (REMOTE_HAULER, RESERVER) - count creeps for this specific room
      const roomCreeps = creeps.filter(
        (c) => c.memory.role === target.role && c.memory.targetRoom === target.memory?.targetRoom
      ).length;
      shouldSpawn = roomCreeps < target.count;
    } else {
      // Global roles (HARVESTER, HAULER, UPGRADER, etc)
      shouldSpawn = countRole(target.role) < target.count;
    }

    if (shouldSpawn) {
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

  // Builders: spawn when construction sites exist (home or remote rooms)
  const sitePriority = getConstructionSitePriority(room.name);
  if (sitePriority.total > 0) {
    // Spawn more builders if there are high-priority sites (non-road, containers)
    const prioritySites = sitePriority.homeNonRoad + sitePriority.remoteContainer;
    const builderCount =
      prioritySites > 0
        ? Math.min(2, Math.ceil(prioritySites / 2)) // 1 builder per 2 priority sites
        : Math.min(1, sitePriority.homeRoad); // Max 1 builder for just roads

    if (builderCount > 0) {
      targets.push({ role: "BUILDER", body: workerBody, count: builderCount });
    }
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

    // Remote Defenders: spawn when hostiles detected in remote rooms
    const hostileRooms = getHostileRemoteRooms(room.name);
    const currentRemoteDefenders = countRemoteDefenders(room.name);
    const maxRemoteDefenders = 2;

    if (hostileRooms.length > 0 && currentRemoteDefenders < maxRemoteDefenders) {
      const remoteDefenderBody: BodyPartConstant[] = [
        TOUGH, TOUGH, ATTACK, ATTACK, ATTACK,
        MOVE, MOVE, MOVE, MOVE, MOVE,
      ]; // 650 energy

      // Prioritize room with most hostiles
      const prioritizedRoom = hostileRooms[0];
      const existingDefenders = countRemoteDefendersForRoom(room.name, prioritizedRoom);

      if (existingDefenders < 1) {
        targets.push({
          role: "REMOTE_DEFENDER",
          body: remoteDefenderBody,
          count: 1,
          memory: { targetRoom: prioritizedRoom },
        });
      }
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

    // Reservers: 1 per remote room (reservation requires constant presence)
    // Find rooms that need a reserver (no reservation or expiring soon, and no reserver assigned)
    const myUsername = Object.values(Game.spawns)[0]?.owner?.username;
    for (const targetRoom of remoteRooms) {
      if (energy < 1300) break; // Not enough energy for reserver

      const intel = Memory.rooms?.[targetRoom];
      const reservation = intel?.controller?.reservation;

      // Check if room needs reservation
      const needsReservation = !reservation ||
        reservation.ticksToEnd < 1000 ||
        reservation.username !== myUsername;

      if (!needsReservation) continue;

      // Check if a reserver is already assigned to this room
      const hasReserver = Object.values(Game.creeps).some(
        (c) =>
          c.memory.role === "RESERVER" &&
          c.memory.targetRoom === targetRoom &&
          c.memory.room === room.name
      );

      if (!hasReserver) {
        const reserverBody: BodyPartConstant[] = [CLAIM, CLAIM, MOVE, MOVE]; // 1300 energy
        targets.push({
          role: "RESERVER",
          body: reserverBody,
          count: 1,
          memory: { targetRoom },
        });
        break; // Spawn one at a time
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

  // Get our username dynamically
  const myUsername = Object.values(Game.spawns)[0]?.owner?.username;

  for (const dir in exits) {
    const roomName = exits[dir as ExitKey];
    if (!roomName) continue;

    const intel = Memory.rooms?.[roomName];
    if (!intel?.sources || intel.sources.length === 0) continue;

    // Skip rooms with hostiles, keepers, or invader cores
    if (intel.hostiles && intel.hostiles > 0) continue;
    if (intel.hasKeepers) continue;
    if (intel.hasInvaderCore) continue;

    // Skip owned rooms (unless ours)
    if (intel.controller?.owner && intel.controller.owner !== myUsername) continue;

    // Skip rooms reserved by others (but allow our own reservations)
    if (intel.controller?.reservation && intel.controller.reservation.username !== myUsername) continue;

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

/**
 * Get all visible remote rooms that we're actively mining
 * (rooms where we have miners assigned)
 */
function getActiveRemoteRooms(homeRoom: string): string[] {
  const remoteRooms: string[] = [];
  const exits = Game.map.describeExits(homeRoom);

  if (!exits) return remoteRooms;

  for (const dir in exits) {
    const roomName = exits[dir as ExitKey];
    if (!roomName) continue;

    // Only include if we have visibility
    if (!Game.rooms[roomName]) continue;

    // Only include if we have active mining creeps there
    const hasMiners = Object.values(Game.creeps).some(
      (c) =>
        c.memory.room === homeRoom &&
        c.memory.role === "REMOTE_MINER" &&
        c.memory.targetRoom === roomName
    );

    if (hasMiners) {
      remoteRooms.push(roomName);
    }
  }

  return remoteRooms;
}

/**
 * Get construction sites prioritized for building.
 * Returns sites from home room first, then remote rooms.
 */
function getConstructionSitePriority(homeRoom: string): {
  homeNonRoad: number;
  homeRoad: number;
  remoteContainer: number;
  total: number;
} {
  let homeNonRoad = 0;
  let homeRoad = 0;
  let remoteContainer = 0;

  // Home room
  const home = Game.rooms[homeRoom];
  if (home) {
    const sites = home.find(FIND_CONSTRUCTION_SITES);
    homeNonRoad = sites.filter((s) => s.structureType !== STRUCTURE_ROAD).length;
    homeRoad = sites.filter((s) => s.structureType === STRUCTURE_ROAD).length;
  }

  // Remote rooms
  const remoteRooms = getActiveRemoteRooms(homeRoom);
  for (const roomName of remoteRooms) {
    const room = Game.rooms[roomName];
    if (room) {
      remoteContainer += room.find(FIND_CONSTRUCTION_SITES, {
        filter: (s) => s.structureType === STRUCTURE_CONTAINER,
      }).length;
    }
  }

  return {
    homeNonRoad,
    homeRoad,
    remoteContainer,
    total: homeNonRoad + homeRoad + remoteContainer,
  };
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

/**
 * Get remote rooms that have hostiles AND would be valid mining targets
 * (if they weren't hostile). We need to defend these to resume mining.
 */
function getHostileRemoteRooms(homeRoom: string): string[] {
  const hostileRooms: string[] = [];
  const exits = Game.map.describeExits(homeRoom);

  if (!exits) return hostileRooms;

  const myUsername = Object.values(Game.spawns)[0]?.owner?.username;

  for (const dir in exits) {
    const roomName = exits[dir as ExitKey];
    if (!roomName) continue;

    const intel = Memory.rooms?.[roomName];
    if (!intel) continue;

    // Skip rooms without sources (nothing to mine)
    if (!intel.sources || intel.sources.length === 0) continue;

    // Skip source keeper rooms (we shouldn't be mining there)
    if (intel.hasKeepers) continue;

    // Skip owned rooms (unless ours)
    if (intel.controller?.owner && intel.controller.owner !== myUsername) continue;

    // Skip rooms reserved by others
    if (intel.controller?.reservation && intel.controller.reservation.username !== myUsername) continue;

    // NOW check if room has hostiles or invader core - this is what we want!
    if ((intel.hostiles && intel.hostiles > 0) || intel.hasInvaderCore) {
      hostileRooms.push(roomName);
    }
  }

  // Sort by hostile count (most hostiles first)
  hostileRooms.sort((a, b) => {
    const aHostiles = Memory.rooms?.[a]?.hostiles || 0;
    const bHostiles = Memory.rooms?.[b]?.hostiles || 0;
    return bHostiles - aHostiles;
  });

  return hostileRooms;
}

/**
 * Count all remote defenders from a home room
 */
function countRemoteDefenders(homeRoom: string): number {
  let count = 0;
  for (const name in Game.creeps) {
    const creep = Game.creeps[name];
    if (creep.memory.role === "REMOTE_DEFENDER" && creep.memory.room === homeRoom) {
      count++;
    }
  }
  return count;
}

/**
 * Count remote defenders assigned to a specific target room
 */
function countRemoteDefendersForRoom(homeRoom: string, targetRoom: string): number {
  let count = 0;
  for (const name in Game.creeps) {
    const creep = Game.creeps[name];
    if (
      creep.memory.role === "REMOTE_DEFENDER" &&
      creep.memory.room === homeRoom &&
      creep.memory.targetRoom === targetRoom
    ) {
      count++;
    }
  }
  return count;
}
