# Known Issues


## A builder held 800 energy for 200 ticks in front of a blocked corridor (FIXED)

**Symptom:** a builder in E47N41, state BUILDING, 800 energy unchanged for 200 ticks,
cycling between 11,23 / 14,20 / 15,19 while five extension sites sat at 0 progress.

**Cause:** two independent faults, and the first masked the second.

1. `Builder.findConstructionSite` sorted sites by `getRangeTo` - straight-line distance -
   and returned the nearest. The nearest by air was unreachable on foot. Clearing
   `targetSiteId` by hand did not help, because the selection immediately reproduced the
   same choice; nor did the build lease expiring. The criterion itself was the defect.
2. The one-tile terrain corridor at 15,18 - the only non-wall tile across that entire row -
   was plugged by an extension this same planner had placed before the chokepoint guard
   existed. North of it a diagonal zigzag of open tiles runs all the way to the sites.

**Diagnosis note:** `findPath(spawn -> site)` reported the sites reachable while
`findClosestByPath` from the builder reported nothing, and the difference was the *origin*,
not the destination. Reading a reachability result without checking which position it was
measured from sent me to the wrong conclusion once already.

**Fix:** `src/creeps/buildTargets.ts` requires a path and skips a whole priority tier when
nothing in it is reachable; the extension at 15,18 was destroyed to reopen the corridor.
Within two ticks the builder emptied its full 800 into the site at 15,14 (0 -> 1600 of
3000) and returned to collect more.

## Three copies of worker energy collection, two dead below the first branch (FIXED)

**Symptom:** dropped energy decaying beside workers who walked to storage instead.

**Cause:** Builder, RemoteBuilder and RoadBuilder each had their own collection chain, and
RemoteBuilder and RoadBuilder both opened with "storage, if it holds more than 1,000".
Storage in a developed room nearly always holds more, so their container and dropped-energy
branches were unreachable in practice - design rule 2. RemoteBuilder also kept a fourth
copy of the same thresholds in `hasCollectableEnergy()` as a release check, with a comment
warning that if the two diverged the creep would "either strand or thrash".

**Fix:** `src/creeps/workerEnergy.ts` owns the decision for all three roles, and the
release check asks the collector instead of mirroring it. The 1,000 floor is gone: under
scoring a nearly-empty storage loses on supply rather than vanishing from the option set.

## Extension sites placed where no creep could reach them (FIXED)

**Symptom:** Immediately after the extension search was widened to radius 22, a builder in
E47N41 sat at 14,20 holding 800 energy for 200+ ticks without spending any. Five of the six
new extension sites showed 0 progress, and `findClosestByPath` from the builder to the set
of sites returned **nothing**.

**Cause:** the widened radius reached into the sealed north of E47N41 - the region behind
the pre-existing extension at 15,18 that once stranded the room's remote miners. The
chokepoint guard is local to a tile's eight neighbours: it prevents a *new* placement from
severing a corridor, but says nothing about ground already walled off. Every one of those
tiles was empty, correctly parity-matched and not a chokepoint, and completely unreachable.
A local guard cannot answer a global question.

**Fix:** `reachableTiles()` in `src/structures/buildGrid.ts` floods the room from the
spawn over walkable tiles - terrain walls and blocking structures alike - and a candidate
must be in that set. The flood starts from the tiles beside the anchor, because a spawn
blocks its own tile.

**Tests:** `npm run test:unit` covers a terrain wall, a structure wall, and the
anchor-blocks-itself case.

## Remote haulers delivered past empty spawns into storage (FIXED)

**Symptom:** dead code by inspection, and the shape that produced several live stalls
elsewhere.

**Cause:** `RemoteHauler.findDeliveryTarget` was an ordered chain whose Priority 1 returned
storage whenever storage had any free capacity. Storage holds 1,000,000 and is effectively
never full, so Priorities 2-4 - controller container, spawn/extensions, any container -
were unreachable in every room that owns storage. A remote hauler would cross two rooms and
pour its load into storage past an empty spawn. Design rule 2.

**Fix:** delivery scoring moved out of `Hauler.ts` into `src/creeps/haulerDelivery.ts` and
both haulers now share it. Storage carries the lowest base of any sink (10 against
spawn/extension 90), so RemoteHauler's separate emergency case became unnecessary - the
spawn network wins by weight rather than by position in a list.

## Haulers waited forever on a container that never reached zero (FIXED)

**Symptom:** two haulers in E46N37 in COLLECTING holding 873 and 450 energy while 27
extensions were empty, storage was 0 and the room ran at 49.7% of capacity. An earlier pair
in the same room had already died in the same state, flagged STUCK at 200 ticks.

**Cause:** the partial-load release in `Hauler.ts` switched to DELIVERING only when the
target container held exactly 0. A static miner sits on its container and transfers as it
harvests, so the container holds a small constant amount - 10, in both of E46N37's - and
`=== 0` was a value that never occurred. The comment said "drained"; the test said zero.

**Fix:** `TOPUP_WORTH_WAITING = 100`. A container holding less than that cannot
meaningfully finish a load, so the hauler delivers what it has.

## Extensions silently stopped being placed in two rooms (FIXED)

**Symptom:** E43N39 sat at 31 extensions of a possible 40 and E47N41 at 40 of 50, for days,
with no extension construction sites queued in either and nothing in any log. For E43N39
that is roughly half again its spawn capacity left unbuilt.

**Cause:** `ExtensionPlanner` searched rings 3 to 10 from the spawn. Measured live, both
rooms had **zero** valid tiles inside that radius and 183 and 92 respectively outside it.
Their search squares are 61% and 79% wall, and the rest is taken by structures, roads
included. A preferred region had become the only region, the same defect the terminal
placement had. The planner logged only on success and had no liveness coverage, so the
stall produced no signal at all.

**Fix:**
- Tile selection moved to `src/structures/buildGrid.ts`, searching out to radius 22 with
  distance charged as a score penalty rather than a hard limit. A near tile still wins
  whenever one exists.
- The corridor guard moved there too, and extension placement now runs through it. That
  guard was private to `placeStructures`, which is how this planner came to place an
  extension in E47N41's only route north and seal its remote miners in.
- The planner is declared in liveness. It reports idle when genuinely at its cap, and
  stays silent-but-not-idle when extensions are missing and no tile can be found - which
  is the state that went unreported.
- `createConstructionSite` failures are now logged instead of discarded.

**Tests:** `npm run test:unit` covers the corridor cases and selection, including the
beyond-radius-10 case that both rooms were stuck in.

## Haulers filled and drained the same terminal; collection was a branch chain (FIXED)

**Symptom:** two FLAP anomalies in E46N37, both haulers hovering at range 1-2 of the
terminal in COLLECTING with nothing carried. Earlier in the same feature, E46N37 held
exactly 30,000 delivered energy across every sample while its extensions ran down.

**Cause, part one - duplicated authority.** Two predicates answered one question: which
way should energy move through this terminal. `terminalWantsEnergy()` (delivery) and
`terminalHasSpare()` (collection) overlapped. A recipient wanted energy below 5,000 and had
spare above 0; a sender wanted it below 25,000 and had spare above 5,000. Inside either band
a hauler filled and drained the same structure.

**Cause, part two - an always-matching branch.** `collect()` was a seven-tier priority
chain, and the terminal drain was placed below branches that could always match - twice.
First below `collectFromContainers()`, which returns true whenever a hauler has a target
container with a miner beside it; then below the adjacent-container shortcut, which fires
for any hauler parked beside a source container refilling at 10/tick. Design rule 2,
written into two consecutive fixes for it.

**Fix:**
- `terminalFlow()` returns exactly one of fill / drain / hold, and both collection and
  delivery read it. Delivery does not offer a draining terminal at all; collection offers
  only a draining one.
- `surplusOf()` counts storage plus terminal, so moving energy between them cannot flip a
  room's sender role. A room that received a transfer within `RECEIVE_HOLDOFF` (3,000
  ticks) cannot send, so a delivery is not passed straight on.
- Collection is scored in `src/creeps/haulerCollection.ts` with a 25-tick lease.
- Storage is only a collection source while the spawn network is short, so a hauler cannot
  withdraw from storage and deliver straight back into it.

**Tests:** `npm run test:unit` covers terminal flow including both old overlap bands, and
collection scoring including the parked-beside-a-container case that starved the drain.

## Haulers boxed in by their own creeps, starving RCL 7 rooms (FIXED)

**Symptom:** E47N41 (RCL 7) sat at 0 storage with 256 of 4,600 extension energy while its
own containers held 2,960 and a link held 776. Both haulers were in COLLECTING with zero
energy. E46N37 showed the same shape.

**Cause:** traffic deadlock. The hauler stood at 5,31 in a pocket with exactly two
walkable exits, and a stationary upgrader occupied each of them. `moveTo` with
`ignoreCreeps: true` returns **OK** - it plans straight through the occupied tile - and
the move then fails silently. No error, no log, nothing to notice. The only recovery was a
random shove every 6 ticks, which cannot help when every exit is blocked.

A stationary creep is a wall that pathfinding cannot see.

**Fix:** `smartMoveTo` now swaps with a friendly creep standing on its next step, after 2
ticks of no movement. Both creeps move in the same tick so the exchange is legal. If the
blocker issues its own move later in the tick, the jam is clearing anyway; the case this
rescues is the blocker that is stationary by design - an upgrader parked at the
controller, a miner on its container - which never issues a move at all.

**Verified:** the wedged hauler moved 5,31 -> 6,30 within a tick of deploy, a container
drained 1,710 -> 410, and E47N41's available energy went 256 -> 1,546.

**Worth noting:** `AnomalyDetector` had already flagged all three frozen haulers with the
correct diagnosis ("energy available and reachable at 7,33 - not collecting it"), and the
findings had been riding to AWS unread. The detector worked; nobody was reading it. That
is what `core/Liveness.ts` and the segment 90 export are for.


## Capacity-sized bodies deadlocked a starved room (FIXED)

**Symptom:** E47N41 (RCL 7, `energyCapacityAvailable` 4600) ran on a **single 200-energy
harvester** while both spawns sat idle, `energyAvailable` frozen at 617 across ~90 ticks,
and its two sources sat full at 3,000 and 1,740.

**Cause:** `resolveSpawnEnergyBudget()` — added earlier the same session to fix the
framework's spawn failures — falls through to sizing bodies at `energyCapacity` when a
room is neither nearly-full nor bank-rich. Waiting for capacity is only rational if
capacity is reachable. A room whose income cannot fill its extensions never reaches it, so
it built nothing, so income never recovered. `ERR_NOT_ENOUGH_ENERGY` was swallowed without
even a log line, so the deadlock was invisible.

This is the "waiting for perfect blocks good" rule, reintroduced by the fix for a
different instance of it.

**Fix:** two release conditions on the capacity gate.
- **No harvesters at all:** the room has no income and every tick of waiting makes it
  poorer, so build whatever is affordable. Deliberately *not* "fewer harvesters than
  sources" — that fires on the common one-harvester-two-sources case and locks the room
  into perpetually tiny bodies, entrenching the spiral it is meant to break. (Tried first;
  it produced a second 50-capacity harvester in E47N41 rather than saving for a real one.)
- **Stalled:** `utilitySpawning` counts each tick it wants a creep it cannot pay for into
  `room.memory._spawnStall`, resetting on a successful spawn. Past `SPAWN_STALL_LIMIT`
  (150) the budget drops to available. Outcome-driven and indifferent to *why* the room is
  poor, so it bounds how long "save for a better body" can last.

The counter has to live at the decision, not at the API call. `getSpawnCandidate()` returns
null when the best candidate is unaffordable and never calls `spawnCreep()`, so counting
`ERR_NOT_ENOUGH_ENERGY` alone left the counter pinned at zero while the room sat deadlocked.

**Verified:** both stall counters climbed to 150 and released. E43N39 spent 662 energy it
had been hoarding on a builder; E47N41 spawned a second hauler. Both counters reset.


## Haulers refused to fill spawn and extensions whenever a filler existed (FIXED)

**Symptom:** E43N39 held 586,590 energy in storage with 19 of 30 extensions empty, 11
energy in the spawn, and three haulers carrying energy they would not deliver. The room
could not spawn anything, and the spawn energy budget consequently sat in its
"wait for capacity" branch permanently.

**Cause:** `scoreDeliveryTargets()` scored spawn and extension delivery as
`base = hasFiller ? 0 : 90`. A zero base annihilates the score, so "a filler is preferred"
silently meant "a filler is the only one allowed" - with no way back when the single
filler fell behind 30 extensions plus a spawn.

Both catalogued rules, in one line: *a preferred source is never the only source*, and
*an early branch that can always match starves everything below it* (a filler almost
always exists).

**Fix:** deference is now conditional on the filler actually coping - measured, not
assumed. Below `FILLER_BEHIND_FRACTION` (50% of `energyCapacityAvailable`) haulers resume
filling at full priority. Above it they use `FILLER_PRESENT_BASE` (12) rather than zero,
so they prefer other work without being locked out.

**Verified:** after deploy the spawn resumed spawning, storage began drawing down for the
first time in the session, and extension fill started climbing.


## Remote creeps frozen at home by a route refusal with no release (FIXED)

**Symptom:** Three remote miners and a reserver assigned to E47N41 stood motionless in
their home room at fatigue 0, not fleeing, with an active target remote, across every
sample taken. Their whole lives, while the colony spawned replacements that did the same.

**Cause:** `moveToRoom()` CASE 3 - when `cachedFindRoute` found no *safe* route and
`findSafeWaypoint()` returned null, the branch called `creep.say("NOSAFE")` and
`return false`. No release condition. In a neighbourhood encircled by one large player,
"no safe route" is the standing condition, not an exception, so the refusal was permanent.
`moveToRoomInternal()` had the same shape one level down.

This is the catalogued defect class: *any predicate that gates progress must have a
release condition.* Refusing to move is not the safe option - a creep that crosses a risky
room might die; a creep that never moves definitely wastes its whole life and its
replacement's.

**Fix:**
- `NO_SAFE_ROUTE_GRACE` (30 ticks): try safe routing, then accept the direct route.
- `moveToRoomInternal` falls back to `findExitTo` instead of returning false.
- `recordUnreachable()` / `isUnreachable()` track routes nothing can reach, and
  `getRemoteMiningTargets()` drops them, so the colony stops paying to spawn creeps that
  never leave home. The record expires (3000 ticks) and is cleared on arrival, so a remote
  recovers by itself once a route reappears. Read with `unreachable()`.

**Verified:** after deploy, six of seven remote creeps that had been stationary were
traversing rooms; one had crossed two room borders toward its target.

## Remote distances were fabricated, not measured (FIXED)

**Symptom:** E47N41 held E44N39 at `distance: 1` and E44N37 at `distance: 2`.
`Game.map.findRoute` puts them at **5** and **7**. Every downstream consumer - hauler
counts, income estimates, remote scoring, the `maxDistance: 2` guard - read the stored
value, so a seven-room haul was budgeted as if the room were adjacent. The miners sent
there could not reach it and stood in the home room.

**Cause:** `Arbitrator.executeRemote()` called
`manager.addRemote(action.room, action.distance || 1, action.via)`. An evaluator that
supplied no distance therefore fabricated the value **1**, and `addRemote()` stored the
caller's number without checking it. A default is not a measurement.

This is also the split architecture doing concrete damage: the framework's
`RemoteMiningEvaluator` writes remote config that `ColonyManager.syncRemoteRooms()` owns,
and the two disagree about the schema - entries written by the evaluator (E47N42, E47N43)
have no `distance` and no `homeColony` at all.

**Fix:**
- `addRemote()` measures the distance itself via `getRouteDistance()`, falling back to
  `Game.map.getRoomLinearDistance()` (free, and a hard lower bound) when the bucket is too
  low to route. It rejects anything beyond the colony's `maxDistance`.
- The `|| 1` fallback is gone from the arbitrator.
- `syncRemoteRooms()` repairs a stored distance that disagrees with the map before
  validating on it, so existing bad entries self-correct and are then removed by the
  existing distance check.

## Memory.colonies accumulated colonies for rooms no longer owned (FIXED)

`Memory.colonies` held 7 entries against 3 owned rooms - E44N37, E44N42, E49N44 and
E45N37 were stale by 2-4M ticks. `getEmpireRemoteAssignments()` scanned all of them, so a
lost colony's remote claims still won overlap arbitration against live colonies.

Fixed: the scan skips colonies whose room is not owned. The four dead entries were purged
from live memory.

## Active Issues

### Remote Targets Validated by Map Route, Not Walkability

**Status:** Open (mitigated)

**Issue:** Four of E47N41's remote creeps sat idle in their home room for hundreds of ticks, correctly assigned to an active remote (E47N43) with a clean two-hop map route, unable to get there.

**Root Cause:** `getRemoteInvalidReason()` validates a remote with `Game.map.findRoute`, which operates on the **room graph** and knows nothing about obstacles *inside* a room. E47N41's 16 player-built `constructedWall` structures seal its entire northern border, and E47N43 is reachable only by exiting north. `findClosestByPath(FIND_EXIT_TOP, {ignoreCreeps: true})` returns `NONE_REACHABLE` from inside the room, while `Game.map.findRoute` cheerfully returns `E47N42>E47N43`.

The creeps could still reach their own spawn, so the room is not sealed — only its northern exit is.

**Mitigation applied:** E47N43 indefinitely paused (`pauseReason` with no `pausedUntil`, which `syncRemoteRooms()` respects permanently) so creeps stop being assigned and spawned for it.

**Fix directions, not yet chosen:**

1. Validate exit reachability, not just a map route — check `findClosestByPath` to the exit direction the route requires. Correct, but costs a pathfind per remote per sync.
2. Let the anomaly detector drive it: a remote whose creeps are repeatedly flagged STUCK in their home room is unreachable in practice, whichever obstacle is responsible.
3. Open a gap or place a rampart in E47N41's north wall — a defensive decision for the operator, and it fixes only this instance.

Option 2 generalises best and reuses machinery that already exists, but this is an architecture-level question about which layer owns reachability, so it is deliberately left for that discussion.

**Files:** `src/core/ColonyManager.ts` (`getRemoteInvalidReason`, `getRouteDistance`)

---

### Spawn Stalls on the Last Distant Extension

**Status:** Fixed

**Issue:** E43N39's climb to RCL 6 ran at ~9 progress/tick with 983,000 banked and its spawn sitting **idle**. It held 2 upgraders against a target of 5.

**Root Cause:** Two throughput defects.

1. **Filler targeting.** `findClosestByPath` treats creeps as obstacles, so a cluster around the spawn made it return `null` even with a hungry spawn two tiles away. The filler then fell through to the tower top-off branch below it and walked across the room while the spawn sat on `WAIT_ENERGY`.
2. **Body sizing.** Bodies are built to exactly `energyCapacityAvailable`, so a room must be **100% full** to spawn anything. E43N39 idled at 1781/1800, blocked on 19 energy in an extension **41 path-steps** from its filler — an ~80-tick round trip gating every spawn.

**Fix Applied:** The filler falls back to `findClosestByRange` when the path query returns empty (`smartMoveTo` does the real pathing and has its own stuck handling). Body sizing builds to `energyAvailable` once available is within 10% of capacity — a room that can reach full is already at full when this is evaluated, so healthy rooms still get full-size bodies; the rule only bites in the band where the room would otherwise idle.

**Files:** `src/creeps/Filler.ts`, `src/spawning/utilitySpawning.ts`

**Verified:** E43N39 spawned at 1781 rather than waiting, and correctly resumed waiting at 1131. Progress rate improved from ~9.3 to ~12.5 per tick.

---

### Room Death Spiral: Filler Stranded by Empty Storage

**Status:** Fixed

**Issue:** E47N41 (RCL 7) fell to two creeps — one filler, one harvester — with both spawns idle at **4/5600 energy**, while its own containers held ~2,796. It could not spawn its way out and was losing creeps to attrition.

**Root Cause:** Two compounding defects.

1. `runFiller()` withdrew only from `room.storage`. With storage at zero the withdraw returned `ERR_NOT_ENOUGH_RESOURCES` every tick and the filler simply stood still — spawn never refilled, nothing could spawn, population decayed. The `EMERGENCY` block above it detects the no-harvesters-and-no-haulers case but only calls `creep.say("SOS")`; it changes no behaviour.
2. Even with a fallback, the room still would not recover: the last filler had `memory.renewing` set, and `runFiller()` short-circuits into `runRenewal()` and returns before any filling. The filler was spending the spawn's last 9 energy to extend its own life (ttl climbing 272 → 287) and would have kept doing so until its renewal target of 522.

**Fix Applied:** The filler falls back to the fullest container, then dropped energy, when storage is empty or absent. Separately, a room below 50% of energy capacity is treated as starved: any in-progress renewal is abandoned and the renewal check skipped entirely, so filling always beats self-preservation.

**Files:** `src/creeps/Filler.ts`

---

### Renewal Blocks Recovery Empire-Wide

**Status:** Fixed

**Issue:** Generalisation of the above. `RenewalManager.run()` returning true makes `main.ts` skip `spawnCreeps()` for that tick entirely, so renewing during a shortage both consumes the energy needed to refill extensions **and** blocks the replacements that would end the shortage.

**Root Cause:** Both `RenewalManager.run()` and `Hauler.shouldRenew()` guarded only on `energyAvailable < 50`. A room at 700/4600 would happily renew and suppress spawning.

**Fix Applied:** Both now bail below 50% of energy capacity, matching the filler rule. Healthy rooms sit near capacity, so normal renewal is unaffected.

**Files:** `src/managers/RenewalManager.ts`, `src/creeps/Hauler.ts`

---

### Room Cannot Spawn the Upgrader That Would Save Its Own RCL

**Status:** Fixed

**Issue:** E46N37 (RCL 7) was decaying through 43,813 of 150,000 ticks toward downgrade with **zero upgraders**, and was structurally incapable of spawning one. Left alone it would have dropped to RCL 6 and lost structures.

**Root Cause:** Two independent blocks.

1. `upgraderUtility()` gates on energy being reachable at the controller — a controller container or link holding energy, or storage above 1000. E46N37 has no controller container, empty links and zero storage, so the gate returned 0 utility.
2. Once bypassed, the room sat in `WAIT_ENERGY`: bodies size to `energyCapacityAvailable`, so it wanted a 4300-energy upgrader while holding 1877 with ~20 energy/tick of income — it would have waited past the downgrade.

**Fix Applied:** A shared `isDowngradeRisk()` helper (ticksToDowngrade below half of `CONTROLLER_DOWNGRADE` for the level). On risk the energy gate is bypassed, utility is floored at 70 so a starved room does not score its upgrader near zero exactly when it needs one, and the body is built from `energyAvailable` so it spawns immediately. Holding the timer is nearly free — each `upgradeController` call restores 100 ticks — so a minimal upgrader now beats a full-size one after the RCL is gone.

**File:** `src/spawning/utilitySpawning.ts`

**Verified:** E46N37 went from 0 upgraders and a falling timer to 3 upgraders and a timer rising 43,680 → 45,222.

---

### Upgraders Deadlock Beside an Empty Controller Link

**Status:** Fixed

**Issue:** E43N39 held controller progress at exactly 109 for 16+ consecutive observation windows while its downgrade timer decayed 34,022 → 20,632. Upgraders were alive, well-bodied (12 WORK), and standing 1–2 tiles from the controller — with zero energy, in `COLLECTING` state, doing nothing. Adding upgraders changed nothing: 1, 2 or 3 upgraders all produced exactly zero controller points.

**Root Cause:** `getEnergy()` in `Upgrader.ts` treated the controller link as the *exclusive* source at RCL 5+. If a link existed but held less than 100 energy, the upgrader moved adjacent, called `creep.say("wait")` and returned — never falling through to the container, storage, or dropped-energy branches below. The comment assumed "link filler will refill shortly", which is only true while the link network actually works. When it doesn't, upgraders idle forever beside an empty link with a full container two tiles away and 1M energy in storage.

**Fix Applied:** The link is now a *preference*, not an exclusive source. An empty or absent link falls through to the normal priority chain (controller container → storage → dropped → any container → source). Waiting is reserved for the genuine case where nothing in the room has energy, and holds beside the link so the next transfer is picked up instantly.

**File:** `src/creeps/Upgrader.ts`

---

### Link Planner Places Duplicate Links for the Same Role

**Status:** Fixed

**Issue:** E43N39's two RCL-5 links sit at (33,13) and (32,12) — both range 2 from the controller, 1–2 tiles from each other. Storage is at (9,37), range 26 away, with no link near it.

**Impact:** A link network needs a sender. With both links on the receiving end there is nothing to transfer *from*, so both sat permanently at 0 energy. This is what starved the upgraders in the issue above.

**Root Cause:** `findLinkPosition()` decided whether the controller or storage already had a link by scanning `FIND_MY_STRUCTURES` only. Construction sites were not counted, so once a controller link site was placed the planner still saw no *built* controller link on the next pass and placed a second site for the same role. The source-link branch further down did check sites (`sourceHasLinkSite`); the controller and storage branches did not.

**Fix Applied:** Both checks now count pending link construction sites as claiming that role, via a shared `hasLinkNear()` helper. Separately, a `null` from `findStorageLinkPosition()` now falls through to source links instead of returning `null` from `findLinkPosition()`, which previously stalled all further link building whenever storage had no viable adjacent spot.

**Note:** this prevents recurrence but does not move E43N39's existing pair. RCL 6 grants a third link, which the corrected planner will now place on the storage side.

**File:** `src/structures/placeStructures.ts` (`findLinkPosition` / `findControllerLinkPosition` / `findStorageLinkPosition`)

---

### AWS AI Advisor Produced Nothing for Months

**Status:** Fixed

**Issue:** The advisor looked healthy from CloudWatch — 288 data-collector runs/day, 864 metrics writes, 24 analysis runs, **zero Lambda errors** — but the recommendations table was completely empty and no AI analysis had ever been stored.

**Root Cause:** Four independent defects, none of which surfaced as a Lambda error:

1. **Retired model.** `analysis-engine` called `claude-sonnet-4-20250514`, which now 404s (`not_found_error`). Every hourly run died at the Claude call. The Lambda caught the exception, so `Errors` stayed at 0 and the failure was invisible to metrics-based monitoring.
2. **Unpaginated Scan.** `getActiveRooms()` issued a single `ScanCommand`. DynamoDB caps a scan page at 1MB of *pre-filter* data and the snapshots table is 2.7MB, so it only ever saw a slice of the table and discovered a subset of rooms — a 3-colony empire was being analyzed one room at a time.
3. **Dead API path.** `fetchLiveData()` called `/live` and `/live/{room}`, which no longer exist (the API exposes `/colonies` and `/colonies/{room}`). Every analysis silently fell back to 5-minute-old snapshots instead of ~40-second-fresh live segment data.
4. **Stale SDK.** `@anthropic-ai/sdk` was pinned at `^0.20.0` (early 2024), which predates adaptive thinking and `output_config.effort`.

**Fix Applied:**

- Model moved to `claude-opus-5` via a `MODEL_ID` env override, with adaptive thinking and `effort: medium`.
- Response parsing selects the `text` block explicitly instead of indexing `content[0]` — with thinking enabled the first block is a thinking block.
- `getActiveRooms()` paginates on `LastEvaluatedKey`.
- `fetchLiveData()` points at `/colonies`.
- SDK upgraded to `^0.122.0`.
- Lambda timeout raised 120s → 300s (a 3-room run takes ~101s and would have been cut off as the empire grows).

**Verified:** all 3 rooms analyzed, live data available, recommendations table populated. The advisor independently detected `RCL_STALL` + `STORAGE_FULL` on E43N39, `NO_UPGRADERS` on E46N37, and `REMOTE_HAULER_SHORTAGE` — matching hand analysis.

**Files:** `aws/lambda/analysis-engine/index.js`, `aws/lambda/analysis-engine/package.json`

**Note:** monitoring this pipeline on Lambda `Errors` is misleading — the handler swallows per-room analysis failures. Alarm on "recommendations table received no writes in N hours" instead.

---

### Remote Mining Deadlocked by Expired Pauses

**Status:** Fixed

**Issue:** All three owned colonies (E46N37, E47N41, E43N39) had **zero** active remotes — 0/20, 0/27 and 0/28 respectively — despite ~60 unclaimed source rooms in intel. The two RCL 7 rooms were left on 2 local sources each and could not fill their storage.

**Root Cause:** A chain of three defects that together made the state permanent:

1. `RemoteMiningEvaluator` pauses a remote on hostile contact, setting `pausedUntil = Game.time + 5000` and `pauseReason = "Hostile detected"`. **No code path ever cleared an expired pause.** Live pauses had `pausedUntil: 73355699` against a current tick of 77,264,600 — expired 3.9M ticks earlier and still in force.
2. `syncRemoteRooms()` Phase 1 skipped cleanup for any entry with a `pauseReason` regardless of expiry, so dead entries were never removed either — including rooms HailHydra had since taken.
3. Phase 3 counted **all** remotes toward `maxRemotes` (4), not just active ones. 20–28 stale entries saturated the cap, so Phase 4 never added a replacement.
4. `findPotentialRemotes()` excludes rooms already in `colony.remotes`, so the framework's `activate_remote` path could not recover them either.

**Fix Applied:** In `syncRemoteRooms()`:

- Expired pauses are cleared and reactivated, then re-validated normally (hostile-owned rooms get removed as usual). Indefinite pauses (`pauseReason` with no `pausedUntil`) are still respected as deliberate.
- `currentCount` counts only active remotes toward the cap.
- New Phase 3b trims over-cap actives by score (weakest first) after a batch reactivation.
- Phase 4 reactivates a known-but-inactive remote instead of skipping it, so trimmed remotes are not stranded off permanently.

**File:** `src/core/ColonyManager.ts`

---

### Full Storage Cannot Be Spent Down

**Status:** Fixed

**Issue:** E43N39 sat at 1,000,000 / 1,000,000 stored energy and dropped 5,418 energy on the ground while remaining at RCL 5.

**Root Cause:** `upgraderTarget = rcl < 8 ? Math.min(rcl, 3) : 1` caps upgraders at 3 regardless of stored energy. `storageUtility()` also saturates at the `high` threshold (400k), so nothing in the system responds to storage beyond that point. A room past the cap has no sink for its surplus.

**Fix Applied:** Rooms with storage above the high-water mark add up to `MAX_SURPLUS_UPGRADERS` (4) extra upgraders, one per half-threshold of surplus, converting dead capital into RCL progress. Rooms with empty storage are unaffected.

**File:** `src/spawning/utilitySpawning.ts`

---

### No Ramparts on Critical Structures

**Status:** Fixed

**Issue:** All three owned rooms had **0 ramparts**. Spawns, towers, storage and terminals were bare, and E46N37 additionally had no safe mode available.

**Root Cause:** No rampart planner existed. `ConstructionCoordinator` listed `STRUCTURE_RAMPART` at priority 7, but nothing generated rampart sites — and that gate requires every higher-priority structure type to be complete first, which would have stalled ramparts behind unfinished extensions anyway.

**Fix Applied:** Added `RampartPlanner`, which ramparts spawns → towers → storage → terminal, up to 3 concurrent sites, running every 25 ticks. It deliberately bypasses `ConstructionCoordinator` so defense does not queue behind economy. Existing `TowerManager` repair logic (ramparts below 10k hits) maintains them. Not a perimeter/min-cut planner — a full wall line is unaffordable for an energy-starved room.

**Files:** `src/structures/RampartPlanner.ts`, `src/main.ts`, `src/utils/Console.ts` (`ramparts()`)

---

### Tick Metrics Collector Records Only Zeros

**Status:** Fixed

**Issue:** All 100 entries in `Memory.stats.tickStats` had `energyHarvested: 0` and zero across every field of `energySpent` and `creepActions`, while creeps were demonstrably harvesting, building and upgrading. The AWS advisor therefore saw room state but no activity signal at all.

**Root Cause:** `StatsCollector` exposes `recordHarvest()`, `recordBuild()`, `recordUpgrade()`, `recordRepair()` and `recordSpawn()`, and `startTick()`/`endTick()` are wired into the main loop — but **nothing anywhere called any of the record* methods**. The instrumentation API was written and never connected, so every tick recorded a freshly-zeroed struct.

**Fix Applied:** Rather than instrument every creep role (many call sites, easy to miss again), `StatsCollector.recordRoomEvents(room)` folds the engine's own `room.getEventLog()` into the tick stats — one call per room in `runRoom()`, capturing harvests, builds, repairs, upgrades, transfers and attacks with exact engine-reported amounts. A central reader has no call sites to forget and cannot drift when a role is added. Spawn cost, the one energy sink the event log does not report, is recorded at the `spawnCreep()` success site.

**Files:** `src/utils/StatsCollector.ts`, `src/main.ts`, `src/spawning/spawnCreeps.ts`

---

### smartMoveTo Blocking Investigation

**Status:** Investigated, fix implemented

**Issue:** Hauler at (8,28) couldn't path to container at (6,28) for 183+ ticks. Defenders at (12,26) and (11,25) somehow blocked the path.

**Root Cause:**
1. `smartMoveTo` used high `reusePath` (50) caching stale paths
2. No stuck detection for single-room movement
3. Path calculated 183 ticks ago when defenders were elsewhere

**Fix Applied:**
- Added stuck detection (`_lastPos`, `_stuckCount`)
- After 3 ticks stuck: recalculate with `ignoreCreeps: true`
- After 5 ticks stuck: random shove to break deadlock
- Lowered default `reusePath` from 50 to 10
- Short-range `ignoreCreeps` when target ≤ 3 tiles

**File:** `src/utils/movement.ts`

**Investigation Doc:** `docs/investigation-smartmoveto-blocking.md`

---

### PIONEER Spawning When No Expansion Active

**Status:** Fixed

**Issue:** PIONEER creeps spawning with `Memory.empire.expansion.active = {}` and `Memory.empire.expansion.queue = []`. Spawn log showed `PIONEER (2/0): 22.5` — 2 current, 0 target, but still getting utility 22.5.

**Root Cause:** In SpawnEvaluator, the saturation factor check was `if (current > 0 && target > 0)`. When target=0, the saturation penalty was skipped entirely. The deficit factor only reduced score by 50% instead of zeroing it.

**Fix Applied:** Added explicit handling for target=0 case in saturation logic:

```typescript
if (target === 0) {
  score = 0;  // Don't spawn when target is 0, regardless of current count
}
```

**File:** `src/framework/evaluators/SpawnEvaluator.ts`

---

### Duplicate Reserver Spawning

**Status:** Fixed

**Issue:** Multiple reservers spawning for same remote room.

**Root Cause:** TTL check pattern `c.ticksToLive && c.ticksToLive > N` didn't count spawning creeps (undefined TTL).

**Fix Applied:** Changed to `(!c.ticksToLive || c.ticksToLive > N)` pattern.

**Files:** `src/spawning/utilitySpawning.ts` (reserverUtility, remoteDefenderUtility, remoteHaulerUtility)

---

### Segment 90 Size Limit

**Status:** Fixed

**Issue:** Memory segment 90 exceeding 100KB limit, causing export failures.

**Fix Applied:**
- Intel TTL filter (1500 ticks)
- Curated creep memory export (essential fields only)
- Graceful degradation (drop diagnostics first, then reduce intel)
- Periodic size logging

**File:** `src/utils/AWSExporter.ts`

---

### Bootstrap Builder Missing selfHarvest Flag

**Status:** Fixed

**Issue:** Bootstrap builders for new colonies weren't getting the `selfHarvest` flag, so they couldn't harvest their own energy and had to wait for haulers.

**Root Cause:** `getCreepMemory()` in utilitySpawning.ts constructed its own memory object instead of using the spawn request from `ExpansionManager.getSpawnRequests()` which includes the `selfHarvest` flag.

**Fix Applied:** Changed `getCreepMemory()` for BOOTSTRAP_BUILDER to use the memory from `ExpansionManager.getSpawnRequests()` which correctly determines which builder should self-harvest.

**File:** `src/spawning/utilitySpawning.ts`

---

### Duplicate Intel Storage (Memory.rooms vs Memory.intel)

**Status:** Fixed (Phase 1 Migration)

**Issue:** Room intel was stored in both `Memory.rooms[roomName]` and `Memory.intel[roomName]`, causing inconsistencies and confusion.

**Root Cause:** Legacy code used `Memory.rooms` for all room data (owned + remote intel), while newer code used `Memory.intel` for scouted room data.

**Fix Applied:**

- All intel reads now use `Memory.intel` exclusively
- `updateRoomIntel()` in remoteIntel.ts is now a no-op (intel gathered centrally)
- `gatherRoomIntel()` in Scout.ts is the single source of truth
- Added `hostileDetails` field to RoomIntel for defense decisions
- `Memory.rooms` now only contains owned-room data (tasks, assignments, containerPlan)

**Files:** Multiple - types.d.ts, Scout.ts, remoteIntel.ts, ColonyManager.ts, utilitySpawning.ts, AWSExporter.ts, Console.ts, RemoteDefender.ts, main.ts, EconomyTracker.ts, RemoteSquadManager.ts, ColonyState.ts

---

### Remote Mining Targets Scattered Logic (Memory.colonies Registry)

**Status:** Fixed (Phase 2 Migration)

**Issue:** Remote mining target derivation was duplicated across ColonyManager.ts and utilitySpawning.ts, with logic re-run every tick.

**Root Cause:** No central registry for per-colony configuration. Remote targets derived on-the-fly from exits + intel every time, wasting CPU and making manual overrides impossible.

**Fix Applied:**

- Added `Memory.colonies[roomName]` registry with `ColonyMemory` interface
- `remoteRooms: string[]` - explicit list of remote mining targets
- `remoteRoomsLastSync: number` - timestamp of last auto-derivation
- Auto-initialized on first run from exits + intel filter
- Re-syncs every 500 ticks (logs additions/removals)
- Console commands for manual control:
  - `remotes()` - list all colonies' remote rooms
  - `addRemote(home, remote)` - add remote room
  - `removeRemote(home, remote)` - remove remote room
  - `syncRemotes(home?)` - force re-derivation
- Abandoned colony cleanup in MemoryManager

**Files:** types.d.ts, ColonyManager.ts, utilitySpawning.ts, Console.ts, AWSExporter.ts, MemoryManager.ts

---

### Builder Stuck on Border Tile

**Status:** Fixed

**Issue:** Builder stuck between E46N37 and E47N37 on the border trying to reach road builds in E47N37.

**Root Cause:** When a creep crosses a room border and is on the edge tile (x=0 or x=49) in the target room, `smartMoveTo()` didn't have special handling since the target room matched the creep's current room. This caused pathfinding issues at room edges.

**Fix Applied:** Added border handling in `smartMoveTo()`: when a creep is stuck on a border tile for 3+ ticks (even if target is in same room), force step off the border before continuing pathfinding.

**File:** `src/utils/movement.ts`

---

### Framework Evaluator Console Spam

**Status:** Fixed

**Issue:** Framework evaluators (spawning, construction, military) were logging to console every tick, flooding output with messages like:

```text
[spawning] E43N39: Spawn HARVESTER (2/2): 0.2...
[military] E44N42: Defend E44N42 (threat: LOW): 92.8
[construction] E47N41: Build link (0/2): 100
```

**Root Cause:** `BaseEvaluator.logEvaluation()` checked `if (Memory.debug)` which was always true if Memory.debug existed with any value.

**Fix Applied:** Changed to explicit opt-in via `Memory.debug.showEvaluations`:

```typescript
if (!Memory.debug?.showEvaluations) return;
```

**Files:** `src/framework/BaseEvaluator.ts`, `src/types.d.ts`

---

### Segment 92 Size Limit

**Status:** Fixed

**Issue:** Telemetry export to segment 92 exceeded 100KB limit.

**Root Cause:** `TelemetryManager` buffered up to 500 decisions, each ~350 bytes, totaling ~175KB.

**Fix Applied:**

- Reduced default maxDecisions from 500 to 200
- Added size-aware truncation (removes oldest decisions if over 90KB)
- Added `truncated` flag for transparency

**File:** `src/framework/Telemetry.ts`

---

### RESERVER Utility Returns NaN

**Status:** Fixed

**Issue:** RESERVER spawning utility returned NaN for some remote rooms, causing spawn evaluator to malfunction.

**Observed:** `[spawning] E43N39: Spawn RESERVER -> E42N39 (0/1): NaN`

**Root Cause:** Remote configs in `Memory.colonies[colony].remotes[room]` could have undefined `distance` or `sources` fields (e.g., configs created by older code or manual console commands). When `WorldState.captureRemotes()` built the remote snapshot, it passed `config.distance` directly without a default. In `SpawnEvaluator.evaluateRemoteRole()`, the calculation `1 - remote.distance * 0.15` produced NaN when distance was undefined.

**Fix Applied:**

Defense in depth - defaults at source AND guards at consumer:

1. WorldState.ts line 388-389: `distance: config.distance ?? 1` and `sources: config.sources ?? 2`
2. SpawnEvaluator.ts line 303: `const distance = remote.distance ?? 1`

**Files:** `src/framework/WorldState.ts`, `src/framework/evaluators/SpawnEvaluator.ts`

---

### WorldState CPU Usage Too High

**Status:** Fixed

**Issue:** `WorldState.capture()` consumed 8-17.5 CPU/tick - 12-25% of the entire CPU budget spent on state capture before any creep logic runs.

**Root Cause:** Multiple expensive operations every tick:

1. Triple `Object.values(Game.creeps).filter()` per remote room (45 iterations for 15 remotes)
2. Unused `room.find(FIND_MY_STRUCTURES)` result (line 117 never read)
3. `EconomyTracker.getMetrics()` creating new instance every tick
4. Full structure/creep snapshot arrays stored but only counts used
5. Duplicate `room.find()` calls in convertMilestones and captureTrafficHotspots

**Fix Applied:**

1. **Creep index cache** - Single `Object.values(Game.creeps)` at start, indexed by room+role+targetRoom
2. **Removed unused code** - Deleted `room.find(FIND_MY_STRUCTURES)` that was never used
3. **Tiered capture frequency** - Structures every 10 ticks, traffic every 50 ticks, threats every tick
4. **Minimal arrays** - Don't store full structure/site arrays, just counts
5. **Shared structure cache** - Pass cached structures to helper functions
6. **AWSExporter integration** - Uses WorldState cache instead of redundant room.find()

**Expected Improvement:** 17.5 CPU → < 5 CPU/tick

**Files:** `src/framework/WorldState.ts`, `src/utils/AWSExporter.ts`

---

### Remote Defender Not Spawning After Miners Flee

**Status:** Fixed

**Issue:** When hostiles appear in a remote mining room, miners flee home. Once all friendly creeps leave, we lose room visibility. Intel stops updating. After 200 ticks, `remoteDefenderUtility()` considered the scan "stale" and returned utility 0. No defender ever spawned. Miners sat at home indefinitely waiting for a defender that never came.

**Root Cause:** `remoteDefenderUtility()` only checked `lastScanned` age and `hostiles` count — both of which go stale when visibility is lost. It didn't use `intel.lastHostileSeen` which persists even without visibility.

Similarly, `getHostileCount()` returned 0 for stale scans even if hostiles were recently seen, causing miners to attempt returning prematurely and re-fleeing in an oscillation loop.

**Fix Applied:**

Two-path threat detection using `lastHostileSeen`:

1. **Fresh scan (lastScanned ≤ 200 ticks)**: Use live `intel.hostiles` count. If hostiles > 0, room is threatened. If 0, room is safe.
2. **Stale scan (lastScanned > 200 ticks)**: Check `intel.lastHostileSeen`. If hostiles were seen within 1500 ticks (invader lifespan) and we DON'T have fresh visibility confirming the room is clear, assume threat persists.

Changes:
- `remoteDefenderUtility()` - spawn defenders for stale threats
- `getHostileCount()` - return ≥1 for stale threats (keeps miners home)
- `findRoomNeedingDefender()` - send defenders to stale-threat rooms
- `findThreatenedRemoteRoom()` - same logic for squad management
- `threats()` console command - shows ASSUMED THREAT for stale-threat rooms

**Files:** `src/spawning/utilitySpawning.ts`, `src/utils/remoteIntel.ts`, `src/creeps/RemoteDefender.ts`, `src/utils/Console.ts`

---

## Limitations

### No Link/Terminal/Lab/Factory Support

**Status:** Not implemented

The bot currently has basic link support but doesn't utilize:
- Terminal (inter-room resource transfer)
- Labs (mineral processing)
- Factory (commodity production)

These are RCL 6-8 features that would improve late-game efficiency.

---

### No Combat Beyond Basic Defenders

**Status:** Limited

Combat capabilities:
- Basic melee defender for home room
- Ranged remote defender with kiting
- Tower-based defense

Missing:
- Squad coordination
- Siege operations
- Boosted combat creeps

---

### Source Keeper Rooms Not Supported

**Status:** By design

SK rooms have permanent hostile NPCs that require specialized combat creeps. Currently avoided in remote mining selection.

---

## Potential Issues

### Hauler Oscillation

**Risk:** Haulers targeting same container, then switching

**Mitigation:** Container assignment at spawn time via `Memory.creeps[name].targetContainer`

**Monitor:** Check for oscillating haulers via `moveStats()`

---

### Extension Fill Race

**Risk:** Multiple haulers trying to fill same extension

**Mitigation:** `findClosestByPath` naturally distributes, but not perfect

**Symptom:** Haulers standing near full extensions

---

### Remote Mining Profitability

**Risk:** Remote rooms too far to be profitable

**Mitigation:** Only mine within 2 rooms of home

**To Monitor:** Energy decay in remote containers, hauler utilization

---

## Debugging Tips

### Stuck Creeps
```javascript
moveStats()  // Shows stuck and oscillating creeps
```

### Task Assignment Issues
```javascript
tasks("W1N1")  // Shows task queue and assignments
```

### Spawning Problems
```javascript
creeps()     // Check current counts
spawn("ROLE") // Force spawn for testing
```

### Economy Issues
```javascript
energy()     // Check energy flow
economy()    // Detailed metrics
haulers()    // Hauler status
```

### Remote Mining Issues
```javascript
remote()              // Overall status
remoteAudit()         // Infrastructure check
intel("room")         // Room data
remotes()             // List remote rooms for all colonies
addRemote(home, room) // Add remote room to colony
removeRemote(home, room) // Remove remote room
syncRemotes(home?)    // Force re-derive remote targets
```
