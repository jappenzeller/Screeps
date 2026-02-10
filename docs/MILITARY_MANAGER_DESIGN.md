# Military Manager — Design Document

## Overview

The Military Manager coordinates offensive and defensive operations across the empire. Its first campaign: take E44N39 from Bazsi1224 by downgrading their controller.

---

## Game Mechanics — Controller Attack

### attackController()
- Removes `300 × CLAIM_PARTS` from `ticksToDowngrade`
- Applies `1000` ticks of `upgradeBlocked` on the controller
- During upgradeBlocked: **no upgrades, no further attacks, no safe mode activation**
- One attack per 1000-tick window (controller-side cooldown)
- Creep must be adjacent (range 1) to controller
- **CLAIM creeps have 600-tick lifespan** (not 1500)

### Downgrade Timers Per RCL
| RCL | Timer      | Energy to next | Notes                           |
|-----|-----------|----------------|----------------------------------|
| 1   | 20,000    | 200            |                                  |
| 2   | 10,000    | 45,000         |                                  |
| 3   | 20,000    | 135,000        |                                  |
| 4   | 40,000    | 405,000        |                                  |
| 5   | 80,000    | 1,215,000      |                                  |
| 6   | 120,000   | 3,645,000      | ← Bazsi is here                  |
| 7   | 150,000   | 10,935,000     |                                  |
| 8   | 200,000   | —              |                                  |

### On Level Downgrade
- Timer resets to **50%** of the new (lower) level's timer
- Structures above new RCL limit are destroyed
- Progress is preserved but level-up blocked while downgrading

### Safe Mode Rules
- Duration: 20,000 ticks
- Cooldown: **50,000 ticks** after activation (not 20k)
- **Cannot activate while upgradeBlocked > 0**
- **Cannot activate when ticksToDowngrade < (maxTimer × 50% + 5000)**
- Blocks attackController while active
- Bazsi has 5 safe modes available

### Tower Damage at Distance
Controller at (6, 34). Base/towers at roughly (20-25, 8-12).
Range ≈ 28-30 tiles → **150 DPS per tower** (minimum). Two towers = **300 DPS**.

CLAIM creep [CLAIM×3, MOVE×3] has 600 HP → dies in 2 ticks under tower fire.
**But the attack only needs 1 tick.** Creep arrives adjacent, calls attackController on the same tick it gets hit. Actions process simultaneously — the attack registers before the creep dies next tick.

---

## Math — Downgrading E44N39

### Attack Effectiveness
With 3 CLAIM parts at 2300 energy cap:
- Body: `[CLAIM, CLAIM, CLAIM, MOVE, MOVE, MOVE]` = 2100 energy
- Per attack: removes **900 ticks** from downgrade timer
- Plus 1000 ticks of upgradeBlocked → natural decay of 1000 ticks (Bazsi can't upgrade)
- **Net reduction per cycle: 1900 ticks per 1000-tick window**

### Timeline to Full Downgrade

| From → To | Start Timer | Cycles | Wall Time (ticks) | Real Time |
|-----------|------------|--------|--------------------|-----------|
| RCL 6→5  | 120,000    | ~64    | 64,000             | ~17.8 hrs |
| RCL 5→4  | 40,000*    | ~22    | 22,000             | ~6.1 hrs  |
| RCL 4→3  | 20,000*    | ~11    | 11,000             | ~3.1 hrs  |
| RCL 3→2  | 10,000*    | ~6     | 6,000              | ~1.7 hrs  |
| RCL 2→1  | 5,000*     | ~3     | 3,000              | ~0.8 hrs  |
| RCL 1→0  | 10,000*    | ~6     | 6,000              | ~1.7 hrs  |
| **Total** |            | ~112   | **112,000**        | **~31 hrs** |

*50% of the new level's max timer after downgrade

### Cost
- 112 CLAIM creeps × 2100 energy each = **235,200 energy total**
- Over 112,000 ticks = **~2.1 energy/tick** — trivial drain on economy
- That's roughly 1 CLAIM creep spawn per 1000 ticks

### Safe Mode Windows
- First ~34 cycles (34,000 ticks): Bazsi CAN safe mode in the gaps between upgradeBlocked periods
- After timer drops below 65,000 (50% of 120k + 5k): safe mode permanently blocked
- Each safe mode costs 20,000 ticks waiting + 50,000 cooldown = 70,000 ticks
- **If Bazsi uses all 5 safe modes: adds 350,000 ticks (~97 hours) to the campaign**
- But safe mode requires CODE to trigger — basic scripts may not have this

---

## Architecture

### New Files

```
src/military/MilitaryManager.ts     — Top-level coordinator
src/military/Campaign.ts            — Campaign state machine
src/military/operations/ControllerAttack.ts  — The attack operation
src/military/operations/TowerDrain.ts        — Decoy tower drain (backup)
src/military/roles/ControllerAttacker.ts     — CLAIM creep role
src/military/roles/Decoy.ts                  — Cheap tower-drain creep
```

### Modified Files

```
src/spawning/utilitySpawning.ts     — Add CONTROLLER_ATTACKER, DECOY utility functions
src/spawning/bodyConfig.ts          — Add body configs
src/spawning/bodyBuilder.ts         — Register in ROLE_MIN_COST
src/utils/Console.ts                — Add military() console commands
src/main.ts                         — Call MilitaryManager.run()
```

---

## Component 1: MilitaryManager (`src/military/MilitaryManager.ts`)

Top-level coordinator that owns campaigns and makes strategic decisions.

### Memory Structure

```typescript
// Memory.military
interface MilitaryMemory {
  campaigns: Record<string, CampaignState>;
  nextCampaignId: number;
  posture: "PEACEFUL" | "ALERT" | "OFFENSIVE";
}

interface CampaignState {
  id: string;
  type: "CONTROLLER_ATTACK" | "ROOM_ASSAULT" | "TOWER_DRAIN";
  targetRoom: string;
  homeRoom: string;         // Primary colony running this campaign
  supportRooms: string[];   // Additional colonies that can contribute
  state: CampaignPhase;
  stateChangedAt: number;
  createdAt: number;
  targetOwner: string;
  
  // Controller attack specific
  controllerAttack?: ControllerAttackState;
}

interface ControllerAttackState {
  controllerPos: { x: number; y: number };
  approachDirection: "south" | "west" | "east" | "north";
  lastAttackTick: number;           // When we last hit the controller
  attackCount: number;              // Total attacks landed
  currentTargetRCL: number;         // Last known target RCL
  currentTicksToDowngrade: number;  // Last known timer
  estimatedTicksRemaining: number;  // Our estimate of when it hits 0
  towerPositions: { x: number; y: number; lastEnergy: number }[];
  safeModeActive: boolean;
  safeModeEndsAt: number;
  upgradeBlockedUntil: number;      // When we can attack again
  
  // Adaptation triggers
  defendersSeen: boolean;
  defendersLastSeen: number;
  towerDrainNeeded: boolean;
}
```

### Campaign Phases

```
PLANNING → SCOUTING → ATTACKING → WAITING_SAFE_MODE → ATTACKING → ... → CLAIMING → SECURING → COMPLETE
```

State transitions:

```typescript
type CampaignPhase =
  | "PLANNING"           // Initial setup, validate target
  | "SCOUTING"           // Send scout for fresh intel
  | "ATTACKING"          // Sending CLAIM creeps to downgrade
  | "WAITING_SAFE_MODE"  // Target activated safe mode, wait it out
  | "WAITING_COOLDOWN"   // upgradeBlocked active, next creep in pipeline
  | "TOWER_DRAINING"     // Sending decoys to drain towers (if needed)
  | "CLAIMING"           // Controller at 0, send claimer to take it
  | "SECURING"           // Room claimed, bootstrap in progress
  | "COMPLETE"           // Campaign finished
  | "ABORTED";           // Campaign cancelled
```

### Core Logic — `run()` (called every tick)

```typescript
function run(): void {
  var mem = getMilitaryMemory();
  
  for (var id in mem.campaigns) {
    var campaign = mem.campaigns[id];
    
    switch (campaign.state) {
      case "PLANNING":
        runPlanning(campaign);
        break;
      case "SCOUTING":
        runScouting(campaign);
        break;
      case "ATTACKING":
        runAttacking(campaign);
        break;
      case "WAITING_SAFE_MODE":
        runWaitingSafeMode(campaign);
        break;
      case "WAITING_COOLDOWN":
        runWaitingCooldown(campaign);
        break;
      case "TOWER_DRAINING":
        runTowerDraining(campaign);
        break;
      case "CLAIMING":
        runClaiming(campaign);
        break;
      case "SECURING":
        runSecuring(campaign);
        break;
    }
  }
}
```

---

## Component 2: Controller Attack Operation

### PLANNING Phase

Validates the campaign is feasible:
1. Check home room has energy capacity for CLAIM creeps (need 2100)
2. Calculate route to target controller
3. Determine approach direction (south for E44N39 — enter from E45N39)
4. Estimate total campaign duration
5. Transition to SCOUTING

### SCOUTING Phase

Send a scout to get fresh intel:
1. Dispatch scout to E44N39
2. On arrival, record:
   - Controller position, current RCL, ticksToDowngrade
   - Tower positions and energy levels
   - Spawn positions
   - Any defender creeps
   - Safe mode status
3. Evaluate: can we proceed or do we need a different approach?
4. If towers are far from controller (range 20+) → proceed to ATTACKING
5. If towers are close → transition to TOWER_DRAINING first

### ATTACKING Phase

The steady-state attack loop. This is the core operation.

**Pipeline management:**
The key challenge is coordinating CLAIM creeps with 600-tick lifespans and 1000-tick attack cooldowns.

```
Timeline:
Tick 0:    Creep A spawns (takes ~25 ticks to spawn 6 parts)
Tick 25:   Creep A starts traveling (4 rooms ≈ 200 ticks)
Tick 225:  Creep A arrives at controller, attacks. upgradeBlocked until tick 1225.
Tick 600:  Creep A dies (600 tick lifespan)
Tick 925:  Creep B spawns (needs to arrive at tick 1225)
Tick 950:  Creep B starts traveling
Tick 1150: Creep B arrives, waits ~75 ticks
Tick 1225: upgradeBlocked expires, Creep B attacks. Blocked until tick 2225.
```

**Spawn timing formula:**
```typescript
var SPAWN_TIME = 6 * 3;  // 6 parts × 3 ticks each = 18 ticks
var TRAVEL_TIME = 200;   // Estimated, 4 rooms at ~50 ticks each
var ATTACK_COOLDOWN = 1000;
var CLAIM_LIFESPAN = 600;

// Spawn next creep so it arrives right when cooldown expires
var spawnAt = lastAttackTick + ATTACK_COOLDOWN - TRAVEL_TIME - SPAWN_TIME;

// Safety: creep must arrive before it dies
// Max wait at controller: CLAIM_LIFESPAN - TRAVEL_TIME - SPAWN_TIME
// = 600 - 200 - 18 = 382 ticks of slack
```

**Each tick in ATTACKING phase:**
```
1. If we have vision on target room:
   - Update controller RCL, ticksToDowngrade, upgradeBlocked
   - Check for safe mode activation → transition to WAITING_SAFE_MODE
   - Check for active defenders → flag defendersSeen
   - Update tower energy levels
   - If controller.level === 0 → transition to CLAIMING

2. If upgradeBlocked is about to expire (within TRAVEL_TIME + SPAWN_TIME):
   - Request next CLAIM creep spawn

3. Manage active CLAIM creeps:
   - If in target room and adjacent to controller and !upgradeBlocked:
     → attackController()
   - If in target room and not adjacent:
     → move to controller
   - If not in target room:
     → moveToRoom(targetRoom)
```

### Adaptation Layer

The operation monitors conditions and adapts:

**Defender Detection:**
```typescript
function checkAdaptation(campaign: CampaignState): void {
  var attack = campaign.controllerAttack;
  var room = Game.rooms[campaign.targetRoom];
  if (!room) return;
  
  // Check for combat creeps near controller
  var controller = room.controller;
  if (!controller) return;
  
  var hostileDefenders = controller.pos.findInRange(FIND_HOSTILE_CREEPS, 5, {
    filter: function(c) {
      return c.getActiveBodyparts(ATTACK) > 0 ||
             c.getActiveBodyparts(RANGED_ATTACK) > 0;
    }
  });
  
  if (hostileDefenders.length > 0) {
    attack.defendersSeen = true;
    attack.defendersLastSeen = Game.time;
    
    // Adapt: send healer escort with next CLAIM creep
    // Or: send duo to clear defenders first, then resume attacks
  }
  
  // Check if towers are actively being refilled
  var towers = room.find(FIND_HOSTILE_STRUCTURES, {
    filter: function(s) { return s.structureType === STRUCTURE_TOWER; }
  }) as StructureTower[];
  
  for (var i = 0; i < towers.length; i++) {
    var tower = towers[i];
    var towerState = attack.towerPositions.find(function(t) {
      return t.x === tower.pos.x && t.y === tower.pos.y;
    });
    
    if (towerState) {
      if (tower.store[RESOURCE_ENERGY] > towerState.lastEnergy + 100) {
        // Tower is being actively refilled — may need drain operation
        attack.towerDrainNeeded = true;
      }
      towerState.lastEnergy = tower.store[RESOURCE_ENERGY];
    }
  }
}
```

**Adaptation responses:**

| Condition | Response |
|-----------|----------|
| Defenders near controller | Send duo escort with CLAIM creep |
| Towers refilling actively | Run tower drain operation in parallel |
| Safe mode activated | Pause, wait it out, resume |
| Target starts upgrading heavily | Increase attack frequency (multiple CLAIM creeps if possible) |
| Our home economy dips | Pause campaign, resume when stable |
| Target RCL drops a level | Log milestone, continue |
| Controller reaches 0 | Transition to CLAIMING |

### WAITING_SAFE_MODE Phase

```typescript
function runWaitingSafeMode(campaign: CampaignState): void {
  var attack = campaign.controllerAttack;
  var room = Game.rooms[campaign.targetRoom];
  
  // If we have vision, check if safe mode ended
  if (room && room.controller) {
    if (!room.controller.safeMode || room.controller.safeMode === 0) {
      attack.safeModeActive = false;
      campaign.state = "ATTACKING";
      campaign.stateChangedAt = Game.time;
      return;
    }
    // Update end estimate
    attack.safeModeEndsAt = Game.time + room.controller.safeMode;
  }
  
  // If no vision, estimate from last known data
  if (Game.time > attack.safeModeEndsAt) {
    // Safe mode should have expired, send scout to verify
    campaign.state = "SCOUTING";
    campaign.stateChangedAt = Game.time;
  }
  
  // Otherwise, just wait. Don't waste creeps.
}
```

### CLAIMING Phase

Controller has reached level 0. Send a standard claimer:

```typescript
function runClaiming(campaign: CampaignState): void {
  // Check if we have a claimer alive heading to target
  var claimers = Object.values(Game.creeps).filter(function(c) {
    return c.memory.role === "CLAIMER" &&
           c.memory.targetRoom === campaign.targetRoom;
  });
  
  if (claimers.length === 0) {
    // Request claimer spawn
    // Use existing claimer spawning from expansion system
    // Just need to set the target room
  }
  
  // Check if room is now ours
  var room = Game.rooms[campaign.targetRoom];
  if (room && room.controller && room.controller.my) {
    campaign.state = "SECURING";
    campaign.stateChangedAt = Game.time;
  }
}
```

### SECURING Phase

Room is claimed. Bootstrap it:
1. Trigger expansion bootstrap (existing ExpansionManager BOOTSTRAPPING flow)
2. Build spawn
3. Monitor until colony is self-sustaining
4. Transition to COMPLETE

---

## Component 3: ControllerAttacker Role

### Role: CONTROLLER_ATTACKER

A specialized CLAIM creep that navigates to a target controller and attacks it.

### Body Config

```typescript
// In bodyConfig.ts
CONTROLLER_ATTACKER: {
  pattern: [CLAIM, MOVE],
  maxRepeats: 3,          // 3 CLAIM + 3 MOVE at RCL 6 (2100 energy)
  minEnergy: 700,         // 1 CLAIM + 1 MOVE minimum
  fallback: [CLAIM, MOVE],
  moveMode: "pattern",
}
```

At RCL 7 (5600 energy): can fit `[CLAIM×5, MOVE×5]` = 3500 energy → 1500 removed per attack.

### Memory

```typescript
interface ControllerAttackerMemory extends CreepMemory {
  role: "CONTROLLER_ATTACKER";
  room: string;          // Home colony
  targetRoom: string;    // Attack target
  campaignId: string;    // Parent campaign
  state: "TRAVELING" | "APPROACHING" | "ATTACKING" | "DONE";
  attacked: boolean;     // Has this creep attacked yet?
}
```

### Behavior

```typescript
function runControllerAttacker(creep: Creep): void {
  var mem = creep.memory as ControllerAttackerMemory;
  
  // Already attacked — just die or recycle
  if (mem.attacked) {
    // Move toward home room to recycle, or just suicide
    if (creep.room.name === mem.room) {
      var spawn = creep.pos.findClosestByRange(FIND_MY_SPAWNS);
      if (spawn && creep.pos.isNearTo(spawn)) {
        spawn.recycleCreep(creep);
      } else if (spawn) {
        creep.moveTo(spawn);
      }
    } else {
      // Not worth traveling home with 600 tick lifespan
      // Just idle or suicide
      creep.suicide();
    }
    return;
  }
  
  // Not in target room — travel
  if (creep.room.name !== mem.targetRoom) {
    moveToRoom(creep, mem.targetRoom);
    creep.say("→ATK");
    return;
  }
  
  // In target room — find controller
  var controller = creep.room.controller;
  if (!controller) {
    creep.say("ERR");
    return;
  }
  
  // Controller is neutral — we took it down, signal campaign
  if (!controller.owner) {
    mem.state = "DONE";
    creep.say("DOWN!");
    return;
  }
  
  // Safe mode active — nothing we can do
  if (controller.safeMode && controller.safeMode > 0) {
    creep.say("SAFE");
    // Move away to avoid wasting time
    return;
  }
  
  // Adjacent to controller — try to attack
  if (creep.pos.isNearTo(controller)) {
    var result = creep.attackController(controller);
    if (result === OK) {
      mem.attacked = true;
      creep.say("HIT!");
      console.log("[Military] " + creep.name + " attacked controller in " +
        mem.targetRoom + " (RCL " + controller.level + ", timer: " +
        controller.ticksToDowngrade + ")");
    } else if (result === ERR_TIRED) {
      // upgradeBlocked still active, wait
      creep.say("WAIT " + (controller.upgradeBlocked || "?"));
    } else {
      creep.say("E:" + result);
    }
  } else {
    // Move to controller — use PathFinder directly to avoid base
    var goal = { pos: controller.pos, range: 1 };
    var ret = PathFinder.search(creep.pos, goal, {
      maxRooms: 1,
      roomCallback: function(roomName) {
        var room = Game.rooms[roomName];
        if (!room) return new PathFinder.CostMatrix();
        
        var costs = new PathFinder.CostMatrix();
        
        // Avoid hostile creeps
        room.find(FIND_HOSTILE_CREEPS).forEach(function(c) {
          costs.set(c.pos.x, c.pos.y, 255);
        });
        
        // Avoid ramparts (can't walk through hostile ramparts)
        room.find(FIND_HOSTILE_STRUCTURES).forEach(function(s) {
          if (s.structureType === STRUCTURE_RAMPART) {
            costs.set(s.pos.x, s.pos.y, 255);
          }
        });
        
        return costs;
      }
    });
    
    if (ret.path.length > 0) {
      creep.moveByPath(ret.path);
    }
    creep.say("→CTRL");
  }
}
```

---

## Component 4: Decoy Role (Tower Drain — Backup Plan)

Only used if towers are actively killing CLAIM creeps before they can attack.

### Body Config

```typescript
DECOY: {
  pattern: [TOUGH, MOVE],
  maxRepeats: 5,
  minEnergy: 60,          // 1 TOUGH + 1 MOVE
  fallback: [TOUGH, MOVE],
  moveMode: "pattern",
}
```

Cost: ~120 energy for `[TOUGH×2, MOVE×2]`. Disposable.

### Behavior

Walk toward enemy towers. Die. Drain tower energy. That's it.

```typescript
function runDecoy(creep: Creep): void {
  var mem = creep.memory;
  
  if (creep.room.name !== mem.targetRoom) {
    moveToRoom(creep, mem.targetRoom);
    return;
  }
  
  // Find closest tower and walk toward it
  var tower = creep.pos.findClosestByRange(FIND_HOSTILE_STRUCTURES, {
    filter: function(s) { return s.structureType === STRUCTURE_TOWER; }
  });
  
  if (tower) {
    creep.moveTo(tower);
    creep.say("BAIT");
  }
}
```

Each decoy absorbs ~20 tower shots (2 towers × ~10 ticks alive) = **400 energy drained** from towers.

---

## Component 5: Spawning Integration

### Utility Functions

```typescript
function controllerAttackerUtility(state: ColonyState): number {
  var mem = getMilitaryMemory();
  
  for (var id in mem.campaigns) {
    var campaign = mem.campaigns[id];
    if (campaign.homeRoom !== state.room.name) continue;
    if (campaign.state !== "ATTACKING") continue;
    
    var attack = campaign.controllerAttack;
    if (!attack) continue;
    
    // Check if we need a new attacker
    // Need one arriving when upgradeBlocked expires
    var timeSinceLastAttack = Game.time - attack.lastAttackTick;
    var ATTACK_COOLDOWN = 1000;
    var TRAVEL_TIME = 200;  // Estimate, could be calculated per-campaign
    var SPAWN_TIME = 18;    // 6 parts × 3 ticks
    
    var spawnWindow = ATTACK_COOLDOWN - TRAVEL_TIME - SPAWN_TIME;
    
    // Check if there's already an attacker in pipeline
    var existingAttackers = Object.values(Game.creeps).filter(function(c) {
      return c.memory.role === "CONTROLLER_ATTACKER" &&
             c.memory.campaignId === id &&
             !(c.memory as any).attacked;
    });
    
    if (existingAttackers.length > 0) return 0;  // One in pipeline
    
    // Time to spawn?
    if (timeSinceLastAttack >= spawnWindow || attack.lastAttackTick === 0) {
      return 60;  // Moderate priority — above remote mining, below home economy
    }
  }
  
  return 0;
}

function decoyUtility(state: ColonyState): number {
  var mem = getMilitaryMemory();
  
  for (var id in mem.campaigns) {
    var campaign = mem.campaigns[id];
    if (campaign.homeRoom !== state.room.name) continue;
    if (campaign.state !== "TOWER_DRAINING") continue;
    
    // Cheap and continuous during drain phase
    var existingDecoys = Object.values(Game.creeps).filter(function(c) {
      return c.memory.role === "DECOY" &&
             c.memory.campaignId === id;
    });
    
    if (existingDecoys.length < 3) return 30;  // Low priority, cheap
  }
  
  return 0;
}
```

### Spawn Memory

```typescript
case "CONTROLLER_ATTACKER": {
  var campaigns = getMilitaryMemory().campaigns;
  for (var cid in campaigns) {
    var campaign = campaigns[cid];
    if (campaign.homeRoom === state.room.name && campaign.state === "ATTACKING") {
      return {
        ...base,
        targetRoom: campaign.targetRoom,
        campaignId: cid,
        state: "TRAVELING",
        attacked: false,
      };
    }
  }
  return base;
}
```

---

## Component 6: Console Commands

```typescript
global.military = {
  // Show all campaign status
  status: function() { return MilitaryManager.status(); },
  
  // Launch controller attack campaign
  attack: function(homeRoom: string, targetRoom: string) {
    return MilitaryManager.createCampaign({
      type: "CONTROLLER_ATTACK",
      homeRoom: homeRoom,
      targetRoom: targetRoom,
    });
  },
  
  // Abort a campaign
  abort: function(campaignId: string) {
    return MilitaryManager.abortCampaign(campaignId);
  },
  
  // Pause/resume
  pause: function(campaignId: string) {
    return MilitaryManager.pauseCampaign(campaignId);
  },
  
  resume: function(campaignId: string) {
    return MilitaryManager.resumeCampaign(campaignId);
  },
  
  // Show detailed attack progress
  progress: function(campaignId: string) {
    return MilitaryManager.attackProgress(campaignId);
  },
  
  // Manually trigger tower drain
  drain: function(campaignId: string) {
    return MilitaryManager.startTowerDrain(campaignId);
  },
};
```

### Status Output Example

```
=== Military Manager ===
Posture: OFFENSIVE
Active Campaigns: 1

[campaign_1] CONTROLLER_ATTACK → E44N39
  State: ATTACKING (since tick 19500000)
  Owner: Bazsi1224
  Target RCL: 6 → 0
  Timer: 98,400 / 120,000 (18% depleted)
  Attacks landed: 24
  Next attack in: ~340 ticks
  CLAIM creep: CONTROLLER_ATTACKER_19500800 [TRAVELING]
  Est. completion: ~88,000 ticks (~24.4 hours)
  Adaptation: No defenders seen, towers at 150 DPS at controller range
```

---

## Component 7: Movement Integration

CONTROLLER_ATTACKER creeps need to route through E45N39 to reach E44N39. The route is:

```
E46N37 → E46N38 → E45N38 → E45N39 → E44N39
```

All normal rooms, no SK rooms on the path. Standard `moveToRoom` works. No changes needed to safe route pathfinding for this campaign.

However, inside E44N39, the creep should pathfind AWAY from the base (north of room) and toward the controller (south-west). The `PathFinder.search` in the role code handles this with hostile structure avoidance.

---

## Component 8: Multi-Colony Support

Once E44N37 reaches RCL 4+, it can contribute CLAIM creeps too:

```
E44N37 → E44N38 → E45N38 → E45N39 → E44N39 (same distance)
```

The campaign's `supportRooms` array enables this:
```typescript
campaign.supportRooms = ["E44N37"];
```

The spawning utility checks both homeRoom and supportRooms for spawn eligibility. Two colonies sending alternating CLAIM creeps could theoretically double the attack rate, but the 1000-tick controller cooldown means only 1 attack per window regardless. The benefit is redundancy — if one colony's creep dies en route, the other can fill in.

---

## Operational Flow — End to End

### Launch
1. Player runs `military.attack("E46N37", "E44N39")`
2. MilitaryManager creates campaign, state = PLANNING
3. Planning validates: energy capacity OK, route exists, target is hostile
4. Transitions to SCOUTING

### Scout
5. Requests scout to E44N39
6. Scout arrives, captures fresh intel
7. Intel shows: RCL 6, towers far from controller, no defenders
8. Transitions to ATTACKING

### Attack Loop
9. Spawns first CONTROLLER_ATTACKER
10. Creep travels 4 rooms (~200 ticks), arrives at controller
11. Attacks: timer reduced by 900, upgradeBlocked set
12. Creep suicides
13. After ~800 ticks, spawn next CONTROLLER_ATTACKER (arrives at tick 1000)
14. Repeat

### Adaptation Points
15. If safe mode triggers → WAITING_SAFE_MODE, pause spawning
16. If defenders appear → flag in memory, send duo escort next time
17. If towers are killing creeps before attack → TOWER_DRAINING parallel op
18. If home economy dips → pause campaign
19. If target RCL drops → log milestone, update estimates

### Victory
20. Controller hits level 0
21. Transition to CLAIMING
22. Send standard CLAIMER from existing expansion system
23. Room claimed → SECURING → bootstrap with ExpansionManager
24. Campaign COMPLETE

---

## Risk Assessment

### Risk: Bazsi Manually Triggers Safe Mode
- **Impact:** +20,000 tick delay per safe mode, 5 available = 100k+ ticks
- **Mitigation:** Patient campaign. 31 hours becomes ~130 hours worst case.
- **Detection:** Monitor `controller.safeMode` when we have vision

### Risk: Bazsi Writes Defender Code
- **Impact:** Combat creeps near controller could kill CLAIM creeps
- **Mitigation:** Send duo escort with CLAIM creep. Healer keeps claimer alive, attacker clears defenders.
- **Escalation:** If serious defense, switch to tower drain + full assault

### Risk: Bazsi Gets Help From Alliance
- **Impact:** Reinforcements via terminal (energy, creeps from another player)
- **Mitigation:** Terminal is empty, likely no alliance. Monitor terminal fills.
- **Escalation:** If terminal starts receiving resources, may need to escalate or abort

### Risk: Our Economy Can't Sustain
- **Impact:** 2.1 energy/tick is trivial, but spawn time is not
- **Mitigation:** CLAIM creep spawns take 18 ticks every 1000 — 1.8% spawn time. Negligible.
- **Gate:** Pause if storage drops below 20,000

### Risk: CLAIM Creep Dies En Route
- **Impact:** Missed attack window, 1000 ticks wasted
- **Mitigation:** Route is through safe territory (all our rooms or uncontested). Low risk.
- **Recovery:** Auto-spawn replacement on next cycle

---

## Implementation Phases

### Phase 1: Core Framework
1. MilitaryManager with memory structure, campaign CRUD, console commands
2. Campaign state machine (PLANNING → SCOUTING → ATTACKING basic loop)
3. ControllerAttacker role with basic travel + attack behavior

### Phase 2: Pipeline
4. Spawn timing logic (schedule CLAIM creeps to arrive on cooldown expiry)
5. Attack counting and progress tracking
6. Vision-based intel updates (timer, RCL, tower energy)

### Phase 3: Adaptation
7. Safe mode detection and WAITING_SAFE_MODE phase
8. Defender detection and duo escort escalation
9. Tower drain operation (DECOY role + parallel state)
10. Economy gate (pause when home is stressed)

### Phase 4: Victory
11. CLAIMING phase integration with existing expansion system
12. SECURING phase bootstrap
13. Campaign completion and cleanup
14. Status output and progress display

---

## Memory Budget

Per campaign: ~300 bytes
Per CONTROLLER_ATTACKER creep: ~100 bytes
Total active: ~500 bytes — negligible

---

## Appendix: Quick Reference — E44N39 Attack

```
Target:      E44N39 (Bazsi1224, RCL 6)
Controller:  (6, 34) — bottom-left
Base:        (~20, 10) — top-right  
Towers:      2, far from controller (~28 range, 150 DPS each)
Approach:    From south via E45N39
Route:       E46N37 → E46N38 → E45N38 → E45N39 → E44N39 (4 rooms)
Travel time: ~200 ticks
Body:        [CLAIM×3, MOVE×3] = 2100 energy
Frequency:   1 creep per 1000 ticks
Attack rate: -900 timer per hit, -1900 effective per cycle
Total cost:  ~235,200 energy over ~31 hours
```
