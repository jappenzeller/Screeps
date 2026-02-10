/**
 * ReclaimBlocker — Reserve a neutral controller to prevent enemy reclaim
 *
 * Body: [CLAIM×1, MOVE×1] = 650 energy (minimal)
 *   reserveController() adds 1 tick per CLAIM part per tick
 *   Only needed when enemy CLAIM creeps are detected
 *
 * Behavior:
 *   1. Travel to target room
 *   2. Move adjacent to controller
 *   3. If enemy CLAIM creep in room → reserveController()
 *   4. If no enemy CLAIM creep → idle adjacent (save reservation for our claimer)
 *   5. If our CLAIMER is in the room → stop reserving, move away
 *
 * IMPORTANT: reserveController() blocks claimController()!
 * Must stop reserving before our claimer arrives.
 * 600-tick lifespan (CLAIM body).
 */

// ReclaimBlockerMemory is stored on creep.memory as any - not extending CreepMemory
// due to state type conflict
export interface ReclaimBlockerMemory {
  role: "RECLAIM_BLOCKER";
  room: string;
  targetRoom: string;
  campaignId: string;
  state: "TRAVELING" | "GUARDING" | "BLOCKING";
}

export function run(creep: Creep): void {
  var mem = creep.memory as unknown as ReclaimBlockerMemory;

  switch (mem.state) {
    case "TRAVELING":
      runTraveling(creep, mem);
      break;
    case "GUARDING":
      runGuarding(creep, mem);
      break;
    case "BLOCKING":
      runBlocking(creep, mem);
      break;
  }
}

function runTraveling(creep: Creep, mem: ReclaimBlockerMemory): void {
  if (creep.room.name === mem.targetRoom) {
    mem.state = "GUARDING";
    return;
  }

  creep.moveTo(new RoomPosition(25, 25, mem.targetRoom), {
    reusePath: 20,
    range: 20,
  });
  creep.say("->BLOCK");
}

function runGuarding(creep: Creep, mem: ReclaimBlockerMemory): void {
  var controller = creep.room.controller;
  if (!controller) return;

  // Move adjacent to controller
  if (!creep.pos.isNearTo(controller)) {
    creep.moveTo(controller, { range: 1 });
    creep.say("->CTRL");
    return;
  }

  // Check for enemy CLAIM creeps
  var enemyClaimers = creep.room.find(FIND_HOSTILE_CREEPS, {
    filter: function(c: Creep) { return c.getActiveBodyparts(CLAIM) > 0; }
  });

  if (enemyClaimers.length > 0) {
    // Enemy trying to reclaim — block them!
    mem.state = "BLOCKING";
    console.log("[ReclaimBlocker] " + creep.name +
      ": Enemy CLAIM creep detected! Reserving controller to block.");
    return;
  }

  // Check if our CLAIMER is here — if so, get out of the way
  var ourClaimers: Creep[] = [];
  for (var name in Game.creeps) {
    var c = Game.creeps[name];
    if (c.memory.role === "CLAIMER" &&
        (c.memory as any).targetRoom === mem.targetRoom &&
        c.room.name === mem.targetRoom) {
      ourClaimers.push(c);
    }
  }

  if (ourClaimers.length > 0) {
    // Our claimer is here — make sure we're not blocking by reserving
    console.log("[ReclaimBlocker] " + creep.name +
      ": Our CLAIMER has arrived. Standing down.");
    creep.suicide();
    return;
  }

  // Idle adjacent to controller — don't reserve unless enemy appears
  creep.say("GUARD");
}

function runBlocking(creep: Creep, mem: ReclaimBlockerMemory): void {
  var controller = creep.room.controller;
  if (!controller) return;

  // Move adjacent if needed
  if (!creep.pos.isNearTo(controller)) {
    creep.moveTo(controller, { range: 1 });
    return;
  }

  // Check if our CLAIMER is here — stop blocking
  var ourClaimers: Creep[] = [];
  for (var name in Game.creeps) {
    var c = Game.creeps[name];
    if (c.memory.role === "CLAIMER" &&
        (c.memory as any).targetRoom === mem.targetRoom &&
        c.room.name === mem.targetRoom) {
      ourClaimers.push(c);
    }
  }

  if (ourClaimers.length > 0) {
    console.log("[ReclaimBlocker] " + creep.name +
      ": Our CLAIMER arrived — releasing reservation.");
    creep.suicide();
    return;
  }

  // Check if enemy CLAIM creeps are still present
  var enemyClaimers = creep.room.find(FIND_HOSTILE_CREEPS, {
    filter: function(c: Creep) { return c.getActiveBodyparts(CLAIM) > 0; }
  });

  if (enemyClaimers.length === 0) {
    // Threat passed — go back to guarding
    mem.state = "GUARDING";
    return;
  }

  // Reserve to block enemy
  var result = creep.reserveController(controller);
  if (result === ERR_NOT_IN_RANGE) {
    creep.moveTo(controller, { range: 1 });
  } else if (result === OK) {
    creep.say("BLOCK!");
  }
}
