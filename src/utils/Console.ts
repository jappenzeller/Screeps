/**
 * Console commands for debugging and status checks.
 * Usage: In Screeps console, type: help(), status(), creeps(), etc.
 */

// Screeps global object
declare const global: {
  [key: string]: unknown;
};

export function registerConsoleCommands(): void {
  // Help command
  global.help = () => {
    console.log(`
=== Screeps Swarm Console Commands ===
status()         - Overview of all colonies
creeps()         - List all creeps
creeps("ROLE")   - List creeps by role (HARVESTER, HAULER, UPGRADER, BUILDER)
rooms()          - List owned rooms
energy()         - Energy status per room
cpu()            - CPU and bucket status
spawn("ROLE")    - Force spawn a creep
spawn("ROLE", "W1N1") - Force spawn in specific room
kill("name")     - Kill a creep by name
`);
  };

  // Status overview
  global.status = () => {
    const lines: string[] = ["=== Colony Status ==="];

    for (const roomName in Game.rooms) {
      const room = Game.rooms[roomName];
      if (!room.controller || !room.controller.my) continue;

      const creeps = Object.values(Game.creeps).filter((c) => c.memory.room === roomName);
      const byRole: Record<string, number> = {};
      for (const c of creeps) {
        byRole[c.memory.role] = (byRole[c.memory.role] || 0) + 1;
      }

      const ctrl = room.controller;
      const sites = room.find(FIND_CONSTRUCTION_SITES).length;
      const hostiles = room.find(FIND_HOSTILE_CREEPS).length;

      lines.push(`\n[${roomName}] RCL ${ctrl.level} (${Math.floor((ctrl.progress / ctrl.progressTotal) * 100)}%)`);
      lines.push(`  Energy: ${room.energyAvailable}/${room.energyCapacityAvailable}`);
      lines.push(`  Creeps: ${creeps.length} - ${Object.entries(byRole).map(([r, n]) => `${r}:${n}`).join(", ")}`);
      if (sites > 0) lines.push(`  Construction sites: ${sites}`);
      if (hostiles > 0) lines.push(`  ⚠️ HOSTILES: ${hostiles}`);
    }

    console.log(lines.join("\n"));
  };

  // List creeps
  global.creeps = (role?: string) => {
    const lines: string[] = [];
    const creeps = Object.values(Game.creeps);

    if (role) {
      const filtered = creeps.filter((c) => c.memory.role === role.toUpperCase());
      lines.push(`=== ${role.toUpperCase()} Creeps (${filtered.length}) ===`);
      for (const c of filtered) {
        lines.push(`  ${c.name} [${c.room ? c.room.name : "?"}] TTL:${c.ticksToLive || "?"} HP:${c.hits}/${c.hitsMax}`);
      }
    } else {
      lines.push(`=== All Creeps (${creeps.length}) ===`);
      const byRole: Record<string, Creep[]> = {};
      for (const c of creeps) {
        if (!byRole[c.memory.role]) byRole[c.memory.role] = [];
        byRole[c.memory.role].push(c);
      }
      for (const [r, list] of Object.entries(byRole)) {
        lines.push(`${r}: ${list.length}`);
        for (const c of list) {
          lines.push(`  - ${c.name} [${c.room ? c.room.name : "?"}] TTL:${c.ticksToLive || "spawning"}`);
        }
      }
    }

    console.log(lines.join("\n"));
  };

  // List rooms
  global.rooms = () => {
    const lines: string[] = ["=== Owned Rooms ==="];

    for (const roomName in Game.rooms) {
      const room = Game.rooms[roomName];
      if (!room.controller || !room.controller.my) continue;

      const spawns = room.find(FIND_MY_SPAWNS);
      const sources = room.find(FIND_SOURCES);
      const ctrl = room.controller;

      lines.push(`\n[${roomName}]`);
      lines.push(`  RCL: ${ctrl.level} (${ctrl.progress}/${ctrl.progressTotal})`);
      lines.push(`  Spawns: ${spawns.map((s) => s.name).join(", ") || "none"}`);
      lines.push(`  Sources: ${sources.length}`);
      lines.push(`  Energy: ${room.energyAvailable}/${room.energyCapacityAvailable}`);
    }

    console.log(lines.join("\n"));
  };

  // Energy status
  global.energy = () => {
    const lines: string[] = ["=== Energy Status ==="];

    for (const roomName in Game.rooms) {
      const room = Game.rooms[roomName];
      if (!room.controller || !room.controller.my) continue;

      const storage = room.storage;
      const containers = room.find(FIND_STRUCTURES, {
        filter: (s) => s.structureType === STRUCTURE_CONTAINER,
      }) as StructureContainer[];

      lines.push(`\n[${roomName}]`);
      lines.push(`  Spawn energy: ${room.energyAvailable}/${room.energyCapacityAvailable}`);
      if (storage) {
        lines.push(`  Storage: ${storage.store[RESOURCE_ENERGY]}`);
      }
      if (containers.length > 0) {
        const total = containers.reduce((sum, c) => sum + c.store[RESOURCE_ENERGY], 0);
        lines.push(`  Containers (${containers.length}): ${total} total`);
      }
    }

    console.log(lines.join("\n"));
  };

  // CPU status
  global.cpu = () => {
    const used = Game.cpu.getUsed();
    const limit = Game.cpu.limit;
    const bucket = Game.cpu.bucket;
    const tickLimit = Game.cpu.tickLimit;

    console.log(`
=== CPU Status ===
Used this tick: ${used.toFixed(2)}
Limit: ${limit}
Tick limit: ${tickLimit}
Bucket: ${bucket}/10000 (${Math.floor((bucket / 10000) * 100)}%)
`);
  };

  // Force spawn a creep
  global.spawn = (role: string, roomName?: string) => {
    const upperRole = role.toUpperCase();
    let targetRoom: Room | undefined;

    if (roomName) {
      targetRoom = Game.rooms[roomName];
    } else {
      // Find first owned room
      for (const name in Game.rooms) {
        const room = Game.rooms[name];
        if (room.controller && room.controller.my) {
          targetRoom = room;
          break;
        }
      }
    }

    if (!targetRoom) {
      console.log("Error: No owned room found");
      return;
    }

    const spawns = targetRoom.find(FIND_MY_SPAWNS);
    const availableSpawn = spawns.find((s) => !s.spawning);

    if (!availableSpawn) {
      console.log(`Error: No available spawn in ${targetRoom.name}`);
      return;
    }

    // Simple body for manual spawning
    const bodies: Record<string, BodyPartConstant[]> = {
      HARVESTER: [WORK, WORK, MOVE],
      HAULER: [CARRY, CARRY, MOVE, MOVE],
      UPGRADER: [WORK, CARRY, MOVE],
      BUILDER: [WORK, CARRY, MOVE],
    };

    const body = bodies[upperRole];
    if (!body) {
      console.log(`Error: Unknown role "${upperRole}". Available: ${Object.keys(bodies).join(", ")}`);
      return;
    }

    const name = `${upperRole}_${Game.time}`;
    const result = availableSpawn.spawnCreep(body, name, {
      memory: { role: upperRole, room: targetRoom.name },
    });

    if (result === OK) {
      console.log(`Spawning ${upperRole} as "${name}" in ${targetRoom.name}`);
    } else {
      console.log(`Failed to spawn: ${result}`);
    }
  };

  // Kill a creep
  global.kill = (name: string) => {
    const creep = Game.creeps[name];
    if (!creep) {
      console.log(`Error: Creep "${name}" not found`);
      return;
    }
    creep.suicide();
    console.log(`Killed creep "${name}"`);
  };

  // Fix creep memory - assigns room based on current position
  global.fix = () => {
    const creeps = Object.values(Game.creeps);
    let fixed = 0;
    for (const creep of creeps) {
      if (!creep.memory.room && creep.room) {
        creep.memory.room = creep.room.name;
        fixed++;
        console.log(`Fixed ${creep.name}: assigned to ${creep.room.name}`);
      }
    }
    console.log(`Fixed ${fixed} creeps`);
  };

  // Debug spawn status
  global.debug = () => {
    const lines: string[] = ["=== Debug Info ==="];

    // List all creeps with their full memory
    lines.push("\nCreep Memory:");
    for (const name in Game.creeps) {
      const c = Game.creeps[name];
      lines.push(`  ${name}: role=${c.memory.role}, room=${c.memory.room || "NONE"}`);
    }

    // Check spawn status
    for (const roomName in Game.rooms) {
      const room = Game.rooms[roomName];
      if (!room.controller || !room.controller.my) continue;

      lines.push(`\n[${roomName}] Spawn Status:`);
      const spawns = room.find(FIND_MY_SPAWNS);
      for (const spawn of spawns) {
        if (spawn.spawning) {
          lines.push(`  ${spawn.name}: BUSY spawning ${spawn.spawning.name}`);
        } else {
          lines.push(`  ${spawn.name}: IDLE`);
        }
      }

      // Count creeps properly assigned to this room
      const assignedCreeps = Object.values(Game.creeps).filter((c) => c.memory.room === roomName);
      const allCreeps = Object.values(Game.creeps).filter((c) => c.room && c.room.name === roomName);
      lines.push(`  Assigned creeps: ${assignedCreeps.length}`);
      lines.push(`  Creeps in room: ${allCreeps.length}`);
    }

    console.log(lines.join("\n"));
  };
}
