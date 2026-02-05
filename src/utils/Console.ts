/**
 * Console commands for debugging and status checks.
 * Usage: In Screeps console, type: help(), status(), creeps(), etc.
 */

import { ColonyManager } from "../core/ColonyManager";
import { getSafeModeStatus } from "../defense/AutoSafeMode";
import { TrafficMonitor } from "../core/TrafficMonitor";
import { StatsCollector } from "./StatsCollector";
import { expansion as empireExpansion, ExpansionManager } from "../empire";

// Helper function for road coverage calculation
function calculatePathRoadCoverage(room: Room, from: RoomPosition, to: RoomPosition): number {
  const path = room.findPath(from, to, {
    ignoreCreeps: true,
    swampCost: 2,
    plainCost: 2,
    range: 1,
  });

  if (path.length === 0) return 1;

  let roadsOnPath = 0;
  for (const step of path) {
    const hasRoad = room.lookForAt(LOOK_STRUCTURES, step.x, step.y)
      .some((s) => s.structureType === STRUCTURE_ROAD);
    if (hasRoad) roadsOnPath++;
  }

  return roadsOnPath / path.length;
}

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
colony()         - Detailed ColonyManager status (phase, workforce, tasks)
colony("W1N1")   - Colony status for specific room
creeps()         - List all creeps
creeps("ROLE")   - List creeps by role (HARVESTER, HAULER, UPGRADER, BUILDER)
rooms()          - List owned rooms
energy()         - Energy status per room
cpu()            - CPU and bucket status
spawn("ROLE")    - Force spawn a creep
spawn("ROLE", "W1N1") - Force spawn in specific room
kill("name")     - Kill a creep by name
resetCreeps()    - Reset all creep states (fixes stuck creeps)
tasks()          - Show ColonyManager task queue
tasks("W1N1")    - Show tasks for specific room
creepStates()    - Show current creep state assignments
remote()         - Remote mining status and targets
remoteAudit()    - Detailed remote infrastructure audit
remotes()        - List remote rooms from colony registry
remotes("W1N1")  - List remotes for specific colony
addRemote(h, r)  - Add remote room r to colony h
removeRemote(h, r) - Remove remote room r from colony h
syncRemotes()    - Force re-derive remote rooms from intel
threats()        - Show hostile creeps and threat levels
safemode()       - Show safe mode status and threat assessment
safemode("W1N1") - Safe mode status for specific room
stats()          - Show collected stats for AWS monitoring
clearStats()     - Clear all collected stats
awsExport()      - Show AWS memory segment export status
construction()   - Show construction status and priorities
advisor()        - Show AI Advisor API endpoints
fetchAdvisor("W1N1") - Show cached recommendations for room
traffic()        - Show traffic heatmap stats for all rooms
traffic("W1N1")  - Show traffic stats for specific room
showTraffic(true/false) - Toggle traffic heatmap visualization
clearTraffic("W1N1") - Clear traffic data for a room
trafficReport("W1N1") - Detailed traffic report with path coverage
suggestRoads("W1N1") - Get road construction commands for hotspots
moveStats()          - Show creeps with movement issues (stuck/oscillating)
expansion.status()   - Show empire expansion status
expansion.start(target, parent) - Start expansion to target room
expansion.queue(target, parent) - Queue expansion for later
expansion.cancel(target) - Cancel expansion
expansion.clear()    - Clear all expansion data (use when stuck)
expansion.debug()    - Show raw Memory.empire data
expansion.candidates() - Show expansion candidate rooms
expansion.readiness() - Check parent colony readiness
expansion.auto(bool) - Toggle auto-expansion
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

  // Colony manager status - detailed view
  global.colony = (roomName?: string) => {
    const rooms = roomName
      ? [roomName]
      : Object.keys(Game.rooms).filter((r) => Game.rooms[r].controller?.my);

    for (const name of rooms) {
      const manager = ColonyManager.getInstance(name);
      const state = manager.getState();
      const phase = manager.getPhase();
      const needs = manager.getWorkforceNeeds();
      const tasks = manager.getTasks();

      console.log(`\n=== ${name} ===`);
      console.log(`Phase: ${phase}`);
      console.log(`RCL: ${state?.rcl || "?"}`);
      console.log(`Energy: ${state?.energy.available}/${state?.energy.capacity}`);

      // Workforce
      console.log(`\nWorkforce:`);
      for (const [role, target] of Object.entries(needs)) {
        const current = manager.getCreepCount(role);
        const status = current >= target ? "✓" : "✗";
        console.log(`  ${status} ${role}: ${current}/${target}`);
      }

      // Tasks
      console.log(`\nTasks (${tasks.length}):`);
      const byType: Record<string, number> = {};
      const assigned: Record<string, number> = {};
      for (const t of tasks) {
        byType[t.type] = (byType[t.type] || 0) + 1;
        if (t.assignedCreep) {
          assigned[t.type] = (assigned[t.type] || 0) + 1;
        }
      }
      for (const [type, count] of Object.entries(byType)) {
        console.log(`  ${type}: ${assigned[type] || 0}/${count} assigned`);
      }
    }

    return "OK";
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

  // Reset all creep states - fixes stuck creeps after code updates
  global.resetCreeps = () => {
    const creeps = Object.values(Game.creeps);
    let reset = 0;

    for (const creep of creeps) {
      // Clear old boolean state
      delete creep.memory.working;
      // Clear new state machine fields
      delete creep.memory.state;
      delete creep.memory.taskId;
      reset++;
    }

    // Clear room assignments
    for (const roomName in Memory.rooms) {
      const roomMem = Memory.rooms[roomName];
      if (roomMem.assignments) {
        delete roomMem.assignments;
      }
    }

    console.log(`Reset ${reset} creeps. All states and task assignments cleared.`);
    console.log(`Next tick, creeps will reinitialize with fresh state.`);
  };

  // Show ColonyManager task queue
  global.tasks = (roomName?: string) => {
    const room = roomName || Object.keys(Game.rooms).find((r) => Game.rooms[r].controller?.my);
    if (!room) {
      console.log("No owned room found");
      return "No room";
    }

    const manager = ColonyManager.getInstance(room);
    const tasks = manager.getTasks();

    console.log(`=== Tasks in ${room} ===`);
    console.log(`Total: ${tasks.length}`);

    for (const task of tasks) {
      const assignee = task.assignedCreep || "unassigned";
      console.log(`  [${task.priority}] ${task.type} → ${assignee}`);
    }

    return "OK";
  };

  // Show current creep state assignments (formerly tasks)
  global.creepStates = () => {
    const lines: string[] = ["=== Creep State Assignments ==="];

    // Group creeps by their current task/state
    const byState: Record<string, Creep[]> = {};
    const creeps = Object.values(Game.creeps);

    for (const c of creeps) {
      const state = c.memory.state || "NO_STATE";
      if (!byState[state]) byState[state] = [];
      byState[state].push(c);
    }

    for (const [state, list] of Object.entries(byState)) {
      lines.push(`\n[${state}] (${list.length} creeps)`);
      for (const c of list) {
        const task = c.memory.taskId ? `task:${c.memory.taskId.substring(0, 8)}` : "no task";
        lines.push(`  ${c.name} (${c.memory.role}) - ${task}`);
      }
    }

    // Show room assignments if they exist
    for (const roomName in Memory.rooms) {
      const roomMem = Memory.rooms[roomName];
      if (roomMem.assignments) {
        lines.push(`\n[${roomName}] Assignments:`);
        if (roomMem.assignments.harvesters) {
          for (const [sourceId, creepName] of Object.entries(roomMem.assignments.harvesters)) {
            lines.push(`  Source ${sourceId.substring(0, 8)}: ${creepName}`);
          }
        }
        if (roomMem.assignments.haulers) {
          for (const [containerId, creepNames] of Object.entries(roomMem.assignments.haulers)) {
            lines.push(`  Container ${containerId.substring(0, 8)}: ${creepNames.join(", ")}`);
          }
        }
      }
    }

    console.log(lines.join("\n"));
  };

  // Remote mining status
  global.remote = () => {
    const firstRoom = Object.keys(Game.rooms).find((r) => Game.rooms[r].controller?.my);
    if (!firstRoom) {
      console.log("No owned room found");
      return "No room";
    }

    const manager = ColonyManager.getInstance(firstRoom);
    const targets = manager.getRemoteMiningTargets();

    console.log("=== Remote Mining ===");
    console.log(`Targets: ${targets.length}`);

    for (const roomName of targets) {
      const intel = Memory.intel && Memory.intel[roomName];
      console.log(`\n${roomName}:`);
      console.log(`  Sources: ${(intel && intel.sources) ? intel.sources.length : 0}`);
      console.log(`  Last scan: ${Game.time - ((intel && intel.lastScanned) ? intel.lastScanned : 0)} ticks ago`);
      console.log(`  Hostiles: ${(intel && intel.hostiles) ? intel.hostiles : 0}`);
    }

    return "OK";
  };

  // Remote mining infrastructure audit
  global.remoteAudit = () => {
    const firstRoom = Object.keys(Game.rooms).find((r) => Game.rooms[r].controller?.my);
    if (!firstRoom) {
      console.log("No owned room found");
      return "No room";
    }

    const homeRoom = Game.rooms[firstRoom];
    const manager = ColonyManager.getInstance(firstRoom);
    const targets = manager.getRemoteMiningTargets();

    console.log("=== Remote Mining Infrastructure Audit ===");
    console.log(`Home Room: ${firstRoom}`);
    console.log(`Target Rooms: ${targets.length}`);

    // Count creeps by type
    const remoteMinerCount: Record<string, number> = {};
    const remoteHaulerCount: Record<string, number> = {};
    const reserverCount: Record<string, number> = {};

    for (const name in Game.creeps) {
      const creep = Game.creeps[name];
      if (creep.memory.room !== firstRoom) continue;
      const targetRoom = creep.memory.targetRoom;
      if (!targetRoom) continue;

      if (creep.memory.role === "REMOTE_MINER") {
        remoteMinerCount[targetRoom] = (remoteMinerCount[targetRoom] || 0) + 1;
      } else if (creep.memory.role === "REMOTE_HAULER") {
        remoteHaulerCount[targetRoom] = (remoteHaulerCount[targetRoom] || 0) + 1;
      } else if (creep.memory.role === "RESERVER") {
        reserverCount[targetRoom] = (reserverCount[targetRoom] || 0) + 1;
      }
    }

    for (const roomName of targets) {
      const room = Game.rooms[roomName];
      const intel = Memory.intel && Memory.intel[roomName];
      const sourceCount = (intel && intel.sources) ? intel.sources.length : 0;

      console.log(`\n--- ${roomName} ---`);
      console.log(`  Sources: ${sourceCount}`);
      console.log(`  Last scan: ${(intel && intel.lastScanned) ? (Game.time - intel.lastScanned) + " ticks ago" : "never"}`);

      // Creep status
      const miners = remoteMinerCount[roomName] || 0;
      const haulers = remoteHaulerCount[roomName] || 0;
      const reservers = reserverCount[roomName] || 0;
      console.log(`  Miners: ${miners}/${sourceCount} (1 per source)`);
      console.log(`  Haulers: ${haulers}/2`);
      console.log(`  Reservers: ${reservers}`);

      // Container status
      if (room) {
        const sources = room.find(FIND_SOURCES);
        let containersBuilt = 0;
        let containerSites = 0;

        for (const source of sources) {
          const containers = source.pos.findInRange(FIND_STRUCTURES, 1, {
            filter: (s) => s.structureType === STRUCTURE_CONTAINER,
          });
          const sites = source.pos.findInRange(FIND_CONSTRUCTION_SITES, 1, {
            filter: (s) => s.structureType === STRUCTURE_CONTAINER,
          });

          if (containers.length > 0) containersBuilt++;
          else if (sites.length > 0) containerSites++;
        }

        const containerStatus = containersBuilt === sourceCount
          ? "COMPLETE"
          : containerSites > 0
          ? `${containersBuilt}/${sourceCount} built, ${containerSites} building`
          : `${containersBuilt}/${sourceCount} NEED ${sourceCount - containersBuilt} more`;
        console.log(`  Containers: ${containerStatus}`);
      } else {
        console.log(`  Containers: [no visibility]`);
      }

      // Road status
      const exitDir = homeRoom.findExitTo(roomName);
      if (exitDir !== ERR_NO_PATH && exitDir !== ERR_INVALID_ARGS && homeRoom.storage) {
        const exitTiles = homeRoom.find(exitDir);
        if (exitTiles.length > 0) {
          const exitCenter = exitTiles[Math.floor(exitTiles.length / 2)];
          const roadCoverage = calculatePathRoadCoverage(homeRoom, homeRoom.storage.pos, exitCenter);
          const roadStatus = roadCoverage >= 0.8 ? "COMPLETE" : `${Math.floor(roadCoverage * 100)}% (need roads)`;
          console.log(`  Road to exit: ${roadStatus}`);
        }
      }

      // Controller reservation status
      if (intel && intel.reservation) {
        const res = intel.reservation;
        console.log(`  Reservation: ${res.username} (${res.ticksToEnd} ticks)`);
      } else {
        console.log(`  Reservation: NONE (need reserver)`);
      }

      // Threats
      console.log(`  Hostiles: ${intel ? (intel.hostiles || 0) : 0}`);
      if (intel && intel.roomType === "sourceKeeper") console.log(`  WARNING: Source keepers present`);
      if (intel && intel.invaderCore) console.log(`  WARNING: Invader core present`);
    }

    // Summary
    console.log(`\n=== Summary ===`);
    const totalMiners = Object.values(remoteMinerCount).reduce((a, b) => a + b, 0);
    const totalHaulers = Object.values(remoteHaulerCount).reduce((a, b) => a + b, 0);
    const neededMiners = targets.reduce((sum, r) => {
      const intel = Memory.intel && Memory.intel[r];
      return sum + ((intel && intel.sources) ? intel.sources.length : 0);
    }, 0);
    const neededHaulers = targets.length * 2;

    console.log(`Total Miners: ${totalMiners}/${neededMiners}`);
    console.log(`Total Haulers: ${totalHaulers}/${neededHaulers}`);
    console.log(`Target Rooms: ${targets.length}`);

    return "OK";
  };

  // Remote room management - list remotes
  global.remotes = (roomName?: string) => {
    var targetRoom = roomName || Object.keys(Game.rooms).find(function(r) {
      return Game.rooms[r].controller && Game.rooms[r].controller.my;
    });
    if (!targetRoom) {
      console.log("No owned room found");
      return "Error";
    }

    if (!Memory.colonies || !Memory.colonies[targetRoom]) {
      console.log("Colony not initialized for " + targetRoom);
      return "Error";
    }

    var colony = Memory.colonies[targetRoom];
    console.log("=== Remote Rooms for " + targetRoom + " ===");
    console.log("Last sync: " + (Game.time - colony.remoteRoomsLastSync) + " ticks ago");

    for (var i = 0; i < colony.remoteRooms.length; i++) {
      var remote = colony.remoteRooms[i];
      var ri = Memory.intel && Memory.intel[remote];
      var sources = ri && ri.sources ? ri.sources.length : 0;
      var hostiles = ri ? (ri.hostiles || 0) : "?";
      var lastScan = ri ? (Game.time - ri.lastScanned) + " ticks ago" : "never";
      console.log("  " + remote + ": " + sources + " sources, " + hostiles + " hostiles, scanned " + lastScan);
    }

    return colony.remoteRooms.length + " remotes";
  };

  // Add a remote room manually
  global.addRemote = (homeRoom: string, remoteRoom: string) => {
    if (!homeRoom || !remoteRoom) {
      console.log("Usage: addRemote('E46N37', 'E45N37')");
      return "Error";
    }
    if (!Memory.colonies || !Memory.colonies[homeRoom]) {
      console.log("Colony not initialized for " + homeRoom);
      return "Error";
    }
    var colony = Memory.colonies[homeRoom];
    if (colony.remoteRooms.indexOf(remoteRoom) !== -1) {
      console.log(remoteRoom + " already in remote list");
      return "Already exists";
    }
    colony.remoteRooms.push(remoteRoom);
    console.log("Added " + remoteRoom + " to " + homeRoom + " remotes");
    return "OK";
  };

  // Remove a remote room manually
  global.removeRemote = (homeRoom: string, remoteRoom: string) => {
    if (!homeRoom || !remoteRoom) {
      console.log("Usage: removeRemote('E46N37', 'E45N37')");
      return "Error";
    }
    if (!Memory.colonies || !Memory.colonies[homeRoom]) {
      console.log("Colony not initialized for " + homeRoom);
      return "Error";
    }
    var colony = Memory.colonies[homeRoom];
    var idx = colony.remoteRooms.indexOf(remoteRoom);
    if (idx === -1) {
      console.log(remoteRoom + " not in remote list");
      return "Not found";
    }
    colony.remoteRooms.splice(idx, 1);
    console.log("Removed " + remoteRoom + " from " + homeRoom + " remotes");
    return "OK";
  };

  // Force re-sync remote rooms from intel
  global.syncRemotes = (roomName?: string) => {
    var targetRoom = roomName || Object.keys(Game.rooms).find(function(r) {
      return Game.rooms[r].controller && Game.rooms[r].controller.my;
    });
    if (!targetRoom) {
      console.log("No owned room found");
      return "Error";
    }
    if (Memory.colonies && Memory.colonies[targetRoom]) {
      // Delete and reinitialize to force sync
      delete Memory.colonies[targetRoom];
      var manager = ColonyManager.getInstance(targetRoom);
      manager.initializeColonyMemory();
      console.log("Re-synced remotes for " + targetRoom);
    }
    return "OK";
  };

  // Threat status
  global.threats = () => {
    for (const roomName in Game.rooms) {
      const room = Game.rooms[roomName];
      if (!room.controller?.my) continue;

      const hostiles = room.find(FIND_HOSTILE_CREEPS);
      if (hostiles.length === 0) {
        console.log(`${roomName}: Safe`);
        continue;
      }

      console.log(`\n${roomName}: ${hostiles.length} hostiles`);
      for (const hostile of hostiles) {
        const attack = hostile.getActiveBodyparts(ATTACK);
        const ranged = hostile.getActiveBodyparts(RANGED_ATTACK);
        const heal = hostile.getActiveBodyparts(HEAL);
        console.log(`  ${hostile.owner.username}: A${attack} R${ranged} H${heal}`);
      }
    }

    return "OK";
  };

  // Safe mode status
  global.safemode = (roomName?: string) => {
    const room = roomName
      ? Game.rooms[roomName]
      : Object.values(Game.rooms).find(r => r.controller?.my);

    if (!room) {
      console.log("No room found");
      return "Error";
    }

    const status = getSafeModeStatus(room);
    console.log(`=== Safe Mode Status for ${room.name} ===`);
    console.log(JSON.stringify(status, null, 2));
    return "OK";
  };

  // AWS export status
  global.awsExport = () => {
    const data = RawMemory.segments[90];
    if (!data) {
      console.log("No export data. Wait for next export tick (every 100 ticks).");
      console.log("To force export: AWSExporter.export()");
      return "No data";
    }

    try {
      const parsed = JSON.parse(data);
      console.log(`Exported at tick: ${parsed.gameTick}`);
      console.log(`Timestamp: ${new Date(parsed.timestamp).toISOString()}`);
      console.log(`Shard: ${parsed.shard}`);
      console.log(`Colonies: ${parsed.colonies.length}`);

      for (const colony of parsed.colonies) {
        console.log(`\n[${colony.roomName}] RCL ${colony.rcl}`);
        console.log(`  Energy: ${colony.energy.available}/${colony.energy.capacity} (stored: ${colony.energy.stored})`);
        console.log(`  Creeps: ${colony.creeps.total}`);
        console.log(`  Threats: ${colony.threats.hostileCount} (DPS: ${colony.threats.hostileDPS})`);
      }

      console.log(`\nGlobal:`);
      console.log(`  CPU: ${parsed.global.cpu.used.toFixed(2)} used, bucket ${parsed.global.cpu.bucket}`);
      console.log(`  GCL: ${parsed.global.gcl.level}`);
      console.log(`  Total creeps: ${parsed.global.totalCreeps}`);

      return "OK";
    } catch (e) {
      console.log("Parse error:", e);
      return "Parse error";
    }
  };

  // Show road construction priorities
  global.roads = () => {
    for (const roomName in Game.rooms) {
      const room = Game.rooms[roomName];
      if (!room.controller || !room.controller.my) continue;

      const spawn = room.find(FIND_MY_SPAWNS)[0];
      if (!spawn) continue;

      const sites = room.find(FIND_CONSTRUCTION_SITES).filter(
        (s) => s.structureType === STRUCTURE_ROAD
      );

      if (sites.length === 0) {
        console.log(`[${roomName}] No road construction sites`);
        continue;
      }

      // Sort by distance from spawn
      sites.sort((a, b) => a.pos.getRangeTo(spawn) - b.pos.getRangeTo(spawn));

      console.log(`[${roomName}] Road sites (sorted by distance from spawn):`);
      for (const site of sites) {
        const dist = site.pos.getRangeTo(spawn);
        const priority = 25 + Math.max(0, 50 - dist);
        console.log(`  ${site.pos.x},${site.pos.y} - dist:${dist} priority:${priority}`);
      }
    }
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

  // Show collected stats for AWS monitoring
  global.stats = () => {
    const stats = Memory.stats;
    if (!stats) {
      console.log("No stats collected yet. Wait a few ticks.");
      return;
    }

    const lines: string[] = ["=== Collected Stats ==="];
    lines.push(`\nTick Stats: ${stats.tickStats.length} entries`);
    lines.push(`Snapshots: ${stats.snapshots.length} entries`);
    lines.push(`Events: ${stats.events.length} entries`);
    lines.push(`Last Snapshot: tick ${stats.lastSnapshotTick}`);

    if (stats.snapshots.length > 0) {
      const latest = stats.snapshots[stats.snapshots.length - 1];
      lines.push(`\nLatest Snapshot (${latest.roomName}):`);
      lines.push(`  Energy: spawn=${latest.energy.spawnAvailable}/${latest.energy.spawnCapacity}, storage=${latest.energy.storage}, containers=${latest.energy.containers}`);
      lines.push(`  Creeps: ${latest.creeps.total} (avgTTL: ${latest.creeps.avgTicksToLive})`);
      lines.push(`  Harvest Efficiency: ${(latest.economy.harvestEfficiency * 100).toFixed(0)}%`);
      lines.push(`  Controller: RCL ${latest.controller.level} (${Math.floor(latest.controller.progress / latest.controller.progressTotal * 100)}%)`);
      lines.push(`  Structures: ${latest.structures.containers} containers, ${latest.structures.extensions} extensions, ${latest.structures.towers} towers`);
      lines.push(`  CPU: ${latest.cpu.used.toFixed(2)} used, bucket ${latest.cpu.bucket}`);
    }

    if (stats.events.length > 0) {
      lines.push(`\nRecent Events:`);
      const recentEvents = stats.events.slice(-5);
      for (const event of recentEvents) {
        lines.push(`  [${event.type}] ${event.roomName} @ tick ${event.gameTick}`);
      }
    }

    console.log(lines.join("\n"));
  };

  // Clear all collected stats
  global.clearStats = () => {
    delete Memory.stats;
    console.log("Stats cleared.");
  };

  // Construction status and priorities
  global.construction = () => {
    const lines: string[] = ["=== Construction Status ==="];

    for (const roomName in Game.rooms) {
      const room = Game.rooms[roomName];
      if (!room.controller || !room.controller.my) continue;

      lines.push(`\n[${roomName}] RCL ${room.controller.level}`);

      // Get all structures by type
      const structures = room.find(FIND_MY_STRUCTURES);
      const sites = room.find(FIND_CONSTRUCTION_SITES);

      const structureCounts: Record<string, { built: number; sites: number; max: number }> = {};

      // Count built structures
      for (const s of structures) {
        if (!structureCounts[s.structureType]) {
          const max = CONTROLLER_STRUCTURES[s.structureType as BuildableStructureConstant]?.[room.controller.level] || 0;
          structureCounts[s.structureType] = { built: 0, sites: 0, max };
        }
        structureCounts[s.structureType].built++;
      }

      // Count construction sites
      for (const s of sites) {
        if (!structureCounts[s.structureType]) {
          const max = CONTROLLER_STRUCTURES[s.structureType as BuildableStructureConstant]?.[room.controller.level] || 0;
          structureCounts[s.structureType] = { built: 0, sites: 0, max };
        }
        structureCounts[s.structureType].sites++;
      }

      // Display by priority order
      const priorityOrder = [
        STRUCTURE_SPAWN, STRUCTURE_CONTAINER, STRUCTURE_EXTENSION, STRUCTURE_TOWER,
        STRUCTURE_STORAGE, STRUCTURE_LINK, STRUCTURE_ROAD, STRUCTURE_WALL, STRUCTURE_RAMPART
      ];

      for (const type of priorityOrder) {
        const counts = structureCounts[type];
        if (!counts && CONTROLLER_STRUCTURES[type as BuildableStructureConstant]?.[room.controller.level] === 0) continue;

        const built = counts?.built || 0;
        const siteCount = counts?.sites || 0;
        const max = CONTROLLER_STRUCTURES[type as BuildableStructureConstant]?.[room.controller.level] || 0;

        if (max === 0 && built === 0 && siteCount === 0) continue;

        let status = "";
        if (built >= max && max > 0) {
          status = "✓ COMPLETE";
        } else if (siteCount > 0) {
          status = `building ${siteCount}`;
        } else if (built < max) {
          status = `NEED ${max - built} more`;
        }

        lines.push(`  ${type}: ${built}/${max} ${status}`);
      }

      // Show remaining site types not in priority order
      for (const type in structureCounts) {
        if (!priorityOrder.includes(type as typeof priorityOrder[number])) {
          const counts = structureCounts[type];
          lines.push(`  ${type}: ${counts.built}/${counts.max} (${counts.sites} sites)`);
        }
      }
    }

    console.log(lines.join("\n"));
  };

  // AI Advisor API endpoints
  global.advisor = () => {
    // This won't work in-game (no fetch), but documents the API
    const apiEndpoint = 'https://your-api-endpoint.execute-api.us-east-1.amazonaws.com';

    console.log('=== AI Advisor ===');
    console.log(`API Endpoint: ${apiEndpoint}`);
    console.log('');
    console.log('Available endpoints:');
    console.log(`  GET ${apiEndpoint}/summary/{roomName}`);
    console.log(`  GET ${apiEndpoint}/recommendations/{roomName}`);
    console.log(`  GET ${apiEndpoint}/metrics/{roomName}?hours=24`);
    console.log(`  POST ${apiEndpoint}/feedback/{recommendationId}`);
    console.log('');
    console.log('To view recommendations, visit the API in a browser or use curl:');
    console.log(`  curl ${apiEndpoint}/recommendations/E46N37`);

    return 'See API endpoints above';
  };

  // Store latest recommendations in Memory for in-game access
  global.fetchAdvisor = (roomName: string) => {
    console.log('Recommendations are stored in Memory.advisor after API fetch');
    console.log('Use external tool to fetch and store:');
    console.log('');
    console.log('// Run this externally:');
    console.log(`fetch('https://your-api/recommendations/${roomName}')`);
    console.log("  .then(r => r.json())");
    console.log("  .then(data => screepsApi.setMemory('advisor', data));");

    // Show cached recommendations if any
    if (Memory.advisor) {
      console.log('\nCached recommendations:');
      for (const rec of Memory.advisor.recommendations || []) {
        console.log(`  [${rec.priority}] ${rec.title}`);
        console.log(`      ${rec.description}`);
      }
    }

    return 'OK';
  };

  // Traffic monitoring commands
  global.traffic = (roomName?: string) => {
    const rooms = roomName
      ? [roomName]
      : Object.keys(Memory.traffic || {});

    if (rooms.length === 0) {
      console.log("No traffic data collected yet. Data accumulates over time.");
      return "No data";
    }

    for (const name of rooms) {
      const mem = Memory.traffic?.[name];
      if (!mem) {
        console.log(`${name}: No traffic data`);
        continue;
      }

      const room = Game.rooms[name];
      if (!room) {
        console.log(`${name}: No visibility (have ${Object.keys(mem.heatmap).length} cached tiles)`);
        continue;
      }

      const monitor = new TrafficMonitor(room);
      const hotspots = monitor.getHotspots(5);
      const stats = monitor.getStats();

      console.log(`\n=== ${name} Traffic ===`);
      console.log(`Window: ${stats.windowProgress}/${mem.windowSize} ticks`);
      console.log(`Tracked tiles: ${stats.trackedTiles}`);
      console.log(`High-traffic tiles: ${stats.highTrafficTiles}`);
      console.log(`Roads suggested: ${stats.suggestedRoads}`);
      console.log(`Roads built (by planner): ${mem.roadsBuilt.length}`);

      if (hotspots.length > 0) {
        console.log(`\nTop hotspots:`);
        for (const spot of hotspots) {
          console.log(`  ${spot.x},${spot.y}: ${spot.visits} visits`);
        }
      }
    }

    return "OK";
  };

  // Toggle traffic heatmap visualization
  global.showTraffic = (enable: boolean = true) => {
    Memory.debug ??= {};
    Memory.debug.showTraffic = enable;
    console.log(`Traffic visualization ${enable ? "enabled" : "disabled"}`);
    console.log("Heatmap will display on owned rooms.");
    return enable ? "enabled" : "disabled";
  };

  // Clear traffic data for a room
  global.clearTraffic = (roomName: string) => {
    if (!roomName) {
      console.log("Usage: clearTraffic('W1N1')");
      return "Error: specify room name";
    }

    if (Memory.traffic?.[roomName]) {
      const room = Game.rooms[roomName];
      if (room) {
        const monitor = new TrafficMonitor(room);
        monitor.clear();
        console.log(`Traffic data cleared for ${roomName}`);
      } else {
        // Clear memory directly if no visibility
        Memory.traffic[roomName] = {
          heatmap: {},
          lastReset: Game.time,
          windowSize: 1000,
          roadsSuggested: [],
          roadsBuilt: [],
        };
        console.log(`Traffic memory cleared for ${roomName} (no visibility)`);
      }
    } else {
      console.log(`No traffic data exists for ${roomName}`);
    }

    return "OK";
  };

  // Detailed traffic report for desire-path model
  // Shows unroaded tiles with high traffic (= places that need roads)
  global.trafficReport = (roomName: string) => {
    if (!roomName) {
      // Use first owned room
      roomName = Object.keys(Game.rooms).find((r) => Game.rooms[r].controller?.my) || "";
    }

    const room = Game.rooms[roomName];
    if (!room) {
      console.log(`Room ${roomName} not visible`);
      return "Error: room not visible";
    }

    const metrics = StatsCollector.exportTrafficMetrics(room);

    console.log(`\n=== Traffic Report: ${roomName} (Desire-Path Model) ===`);
    console.log(`\nUnroaded Traffic Tracking:`);
    console.log(`  Tiles tracked: ${metrics.trackedTiles} (unroaded tiles with traffic)`);
    console.log(`  Desire paths: ${metrics.desirePaths} (tiles with 50+ visits - ready for roads)`);
    console.log(`  Window: ${metrics.windowProgress}/${metrics.windowSize} ticks`);

    console.log(`\nRoad Status:`);
    console.log(`  Total roads: ${metrics.roads.total}`);
    console.log(`  Built by planner: ${metrics.roads.builtByPlanner}`);

    if (metrics.hotspots.length > 0) {
      console.log(`\nTop Hotspots (NEED ROADS):`);
      for (const h of metrics.hotspots.slice(0, 5)) {
        const swampNote = h.terrain === "swamp" ? " ★SWAMP" : "";
        console.log(`  (${h.x},${h.y}): ${h.visits} visits [${h.terrain}]${swampNote} priority=${h.priority}`);
      }
    } else {
      console.log(`\nNo hotspots yet - traffic data accumulating.`);
    }

    console.log(`\nPath Coverage (roads on optimal paths):`);
    for (const p of metrics.pathCoverage.spawnToSources) {
      const pct = (p.coverage * 100).toFixed(0);
      const status = p.coverage >= 0.8 ? "✓" : p.coverage >= 0.5 ? "~" : "✗";
      console.log(`  ${status} spawn→source: ${pct}% (${p.distance} tiles)`);
    }
    const ctrlPct = (metrics.pathCoverage.spawnToController.coverage * 100).toFixed(0);
    const ctrlStatus = metrics.pathCoverage.spawnToController.coverage >= 0.8 ? "✓" : "~";
    console.log(`  ${ctrlStatus} spawn→controller: ${ctrlPct}% (${metrics.pathCoverage.spawnToController.distance} tiles)`);

    if (metrics.pathCoverage.spawnToStorage) {
      const storagePct = (metrics.pathCoverage.spawnToStorage.coverage * 100).toFixed(0);
      const storageStatus = metrics.pathCoverage.spawnToStorage.coverage >= 0.8 ? "✓" : "~";
      console.log(`  ${storageStatus} spawn→storage: ${storagePct}% (${metrics.pathCoverage.spawnToStorage.distance} tiles)`);
    }

    console.log(`\nEfficiency:`);
    console.log(`  Swamp traffic: ${metrics.efficiency.swampTraffic} visits (lower is better)`);
    if (metrics.efficiency.swampTraffic > 100) {
      console.log(`    ⚠ Consider prioritizing swamp roads to reduce fatigue`);
    }

    return "OK";
  };

  // Movement stats - show creep positions (simplified after removing complex movement tracking)
  global.moveStats = () => {
    const lines: string[] = ["=== Movement Stats ==="];
    const byRole: Record<string, number> = {};

    for (const name in Game.creeps) {
      const creep = Game.creeps[name];
      const role = creep.memory.role || "UNKNOWN";
      byRole[role] = (byRole[role] || 0) + 1;
    }

    lines.push("Creep counts by role:");
    for (const [role, count] of Object.entries(byRole)) {
      lines.push(`  ${role}: ${count}`);
    }

    lines.push("\nNote: Complex movement tracking was removed for stability.");
    lines.push("Use traffic() to see high-traffic areas.");

    console.log(lines.join("\n"));
    return "OK";
  };

  // Get road construction commands for hotspots
  global.suggestRoads = (roomName: string) => {
    if (!roomName) {
      // Use first owned room
      roomName = Object.keys(Game.rooms).find((r) => Game.rooms[r].controller?.my) || "";
    }

    const room = Game.rooms[roomName];
    if (!room) {
      console.log(`Room ${roomName} not visible`);
      return "Error: room not visible";
    }

    const metrics = StatsCollector.exportTrafficMetrics(room);

    console.log(`\n=== Road Suggestions: ${roomName} ===`);
    console.log(`Desire paths (50+ visits): ${metrics.desirePaths}`);
    console.log(`\nCopy-paste these commands to build roads at top hotspots:\n`);

    for (const h of metrics.hotspots.slice(0, 5)) {
      const priority = h.terrain === "swamp" ? "HIGH (swamp)" : "medium";
      console.log(`Game.rooms['${roomName}'].createConstructionSite(${h.x}, ${h.y}, STRUCTURE_ROAD); // ${h.visits} visits, ${h.terrain}, ${priority}`);
    }

    if (metrics.hotspots.length === 0) {
      console.log("No hotspots found yet. Traffic data accumulates over time.");
      console.log("Note: Only unroaded tiles are tracked - if paths are roaded, no data shows.");
    }

    return "OK";
  };

  // Empire expansion commands
  global.expansion = {
    status: () => {
      console.log(ExpansionManager.status());
      return "OK";
    },

    start: (targetRoom: string, parentRoom?: string) => {
      if (!targetRoom) {
        console.log("Usage: expansion.start('E47N39', 'E46N37')");
        console.log("  targetRoom: Room to expand to (required)");
        console.log("  parentRoom: Room to support expansion (optional)");
        return "Error: specify target room";
      }

      // Find parent room if not specified
      if (!parentRoom) {
        parentRoom = Object.keys(Game.rooms).find(function(r) {
          var room = Game.rooms[r];
          return room.controller && room.controller.my && room.controller.level >= 4;
        });
      }

      if (!parentRoom) {
        console.log("Error: No suitable parent room found (need RCL 4+)");
        return "Error: no parent room";
      }

      var result = empireExpansion.start(targetRoom, parentRoom);
      if (result) {
        console.log("Started expansion to " + targetRoom + " from " + parentRoom);
        console.log("Use expansion.status() to monitor progress");
      } else {
        console.log("Failed to start expansion");
      }

      return result ? "OK" : "Failed";
    },

    queue: function(targetRoom: string, parentRoom?: string) {
      if (!targetRoom) {
        console.log("Usage: expansion.queue('E47N39', 'E46N37')");
        return "Error: specify target room";
      }

      if (!parentRoom) {
        parentRoom = Object.keys(Game.rooms).find(function(r) {
          var room = Game.rooms[r];
          return room.controller && room.controller.my && room.controller.level >= 4;
        });
      }

      if (!parentRoom) {
        console.log("Error: No suitable parent room found");
        return "Error: no parent room";
      }

      return empireExpansion.queue(targetRoom, parentRoom);
    },

    cancel: function(targetRoom: string) {
      if (!targetRoom) {
        console.log("Usage: expansion.cancel('E47N39')");
        return "Error: specify target room";
      }
      return empireExpansion.cancel(targetRoom);
    },

    clear: function() {
      return empireExpansion.clear();
    },

    debug: function() {
      return empireExpansion.debug();
    },

    candidates: function(count?: number) {
      return empireExpansion.candidates(count);
    },

    readiness: function() {
      return empireExpansion.readiness();
    },

    auto: function(enable?: boolean) {
      return empireExpansion.auto(enable);
    },
  };

  // Emergency rescue: dispatch pioneer from one colony to bootstrap another
  global.rescueColony = function(fromRoom: string, toRoom: string): string {
    var from = Game.rooms[fromRoom];
    if (!from) return 'Cannot see room ' + fromRoom;

    var spawn = from.find(FIND_MY_SPAWNS).find(function(s) { return !s.spawning; });
    if (!spawn) return 'No available spawn in ' + fromRoom;

    // Build a small pioneer that can bootstrap the target colony
    // Use available energy, min 300 (WORK+CARRY+CARRY+MOVE+MOVE)
    var energy = Math.min(from.energyAvailable, 800);
    if (energy < 300) return 'Not enough energy in ' + fromRoom + ' (need 300, have ' + energy + ')';

    var body: BodyPartConstant[] = [];
    var remaining = energy;

    // Build balanced WORK/CARRY/MOVE
    while (remaining >= 250 && body.length < 30) {
      body.push(WORK);   // 100
      body.push(CARRY);  // 50
      body.push(MOVE);   // 50
      remaining -= 200;
      if (remaining >= 50) {
        body.push(MOVE); // extra move for road-less travel
        remaining -= 50;
      }
    }

    var name = 'RESCUE_' + toRoom + '_' + Game.time;
    var result = spawn.spawnCreep(body, name, {
      memory: {
        role: 'PIONEER',
        room: toRoom,
        selfHarvest: true,
      } as any,
    });

    if (result === OK) {
      var cost = body.reduce(function(sum, p) { return sum + BODYPART_COST[p]; }, 0);
      return 'Spawning rescue pioneer ' + name + ' (' + body.length + ' parts, cost ' + cost + ') from ' + fromRoom + ' -> ' + toRoom;
    } else {
      return 'Spawn failed: ' + result;
    }
  };
}
