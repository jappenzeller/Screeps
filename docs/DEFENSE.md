# Defense System

## Overview

Defense is handled through:
1. **Towers** - Primary defense, instant room-wide coverage
2. **Defenders** - Melee creeps for home room
3. **Remote Defenders** - Ranged creeps for remote rooms
4. **Safe Mode** - Emergency last resort

## Towers (TowerManager.ts)

Towers are the primary defense. They:
- Attack any hostile in range (50 tiles = entire room)
- Heal friendly creeps
- Repair damaged structures

### Priority Order

```
1. HEAL - Friendly creeps below max HP
2. REPAIR - Critical structures (spawn, storage)
3. ATTACK - Hostile creeps
```

### Damage Falloff

Tower damage decreases with range:
- Range 0-5: 600 damage
- Range 5-20: Linear falloff
- Range 20-50: 150 damage

**Implication:** Towers most effective near center of base.

### Tower Count by RCL

| RCL | Towers | Combined DPS (point blank) |
|-----|--------|---------------------------|
| 3 | 1 | 600 |
| 5 | 2 | 1,200 |
| 7 | 3 | 1,800 |
| 8 | 6 | 3,600 |

## Defenders (Home Room)

### DEFENDER Role

**Spawn trigger:** Hostiles detected (utility 65)

**Body:**
```typescript
[TOUGH, TOUGH, ATTACK, ATTACK, MOVE, MOVE, MOVE, MOVE]
```

**Behavior:**
1. Move toward nearest hostile
2. Attack when in range
3. Retreat when HP low (tower heals)

### When to Use Defenders

- Towers can't handle threat alone
- Multiple hostiles with healing
- Hostiles hiding in rampart shadow

**Rule of thumb:** Towers handle most invasions. Defenders are backup.

## Remote Defenders (RemoteDefender.ts)

### REMOTE_DEFENDER Role

Protects remote mining operations from invaders.

**Spawn trigger:** Hostiles in remote room (utility 65)

**Body (hybrid):**
```typescript
[TOUGH, TOUGH, RANGED_ATTACK, RANGED_ATTACK, HEAL, MOVE, MOVE, MOVE, MOVE, MOVE]
```

**Behavior:**
1. Travel to threatened remote room
2. Kite hostiles (maintain range 3)
3. Use ranged attack
4. Self-heal when damaged
5. Retreat if overwhelmed

### Kiting Logic

```typescript
// If hostile in melee range, move away
if (hostile.pos.getRangeTo(creep) <= 1) {
  PathFinder.search(creep.pos, hostile.pos, { flee: true });
}

// Attack from range 3
if (hostile.pos.getRangeTo(creep) <= 3) {
  creep.rangedAttack(hostile);
}
```

## Safe Mode (AutoSafeMode.ts)

Emergency protection that makes room invulnerable.

### Triggers

Auto-triggers when:
- Spawn HP < 50%
- Controller near downgrade

### Cooldown

- Duration: 20,000 ticks
- Cooldown: 20,000 ticks after expiration
- Can only activate if not on cooldown

### When NOT to Use

- Minor raids (towers can handle)
- Remote room threats (safe mode is home-only)
- Source keeper rooms (permanent hostiles)

## Threat Assessment

### Hostile DPS Calculation

```typescript
function calculateHostileDPS(hostile: Creep): number {
  const attack = hostile.getActiveBodyparts(ATTACK) * 30;
  const ranged = hostile.getActiveBodyparts(RANGED_ATTACK) * 10;
  return attack + ranged;
}
```

### Threat Levels

| DPS | Level | Response |
|-----|-------|----------|
| 0 | None | Normal operations |
| 1-100 | Low | Towers only |
| 100-300 | Medium | Towers + 1-2 defenders |
| 300+ | High | Full defense, consider safe mode |

## Ramparts and Walls

### Ramparts

- Only you can walk through
- Decays over time (needs repair)
- Protects structures underneath

**Use for:**
- Chokepoint defense
- Protecting spawn/storage

### Walls

- Nobody can walk through
- No decay
- 1 HP (needs massive reinforcement)

**Use for:**
- Blocking paths
- Creating kill zones

### HP Targets by RCL

| RCL | Target HP | Notes |
|-----|-----------|-------|
| 3-4 | 10,000 | Basic protection |
| 5-6 | 100,000 | Moderate defense |
| 7 | 1,000,000 | Strong defense |
| 8 | 10,000,000+ | Maximum defense |

## Defense Memory

```typescript
Memory.rooms[roomName] = {
  threats: [{
    id: string,
    dps: number,
    healPower: number,
    lastSeen: number
  }],
  defenseState: "NORMAL" | "ALERT" | "EMERGENCY",
  lastAttack: number
}
```

## Colony Phases and Defense

| Phase | Defense Behavior |
|-------|-----------------|
| BOOTSTRAP | Minimal (no towers yet) |
| DEVELOPING | Tower-only defense |
| STABLE | Full defense capability |
| EMERGENCY | All resources to defense |

### EMERGENCY Phase

Triggered by hostiles with attack capability:
- All spawning paused except defenders
- Towers prioritize attack over repair
- Safe mode considered if critical

## Console Commands

```javascript
threats()                // List all threats
threats("W1N1")          // Room-specific threats
safemode()               // Safe mode status
safemode("W1N1")         // Activate safe mode
defenders()              // List defender creeps
```

## Common Issues

### Tower Not Attacking
**Cause:** No energy in tower
**Fix:** Check hauler delivery, tower fill priority

### Defender Dies Instantly
**Cause:** Overwhelmed by hostiles
**Fix:** Spawn more defenders or use safe mode

### Remote Miners Keep Dying
**Cause:** Invaders spawning faster than defenders
**Fix:** Check remote defender spawning (utility 65)

### Safe Mode on Cooldown
**Cause:** Used recently
**Fix:** Improve base defense to avoid needing it
