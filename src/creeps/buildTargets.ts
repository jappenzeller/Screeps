/**
 * buildTargets - which construction site a builder should work on.
 *
 * Selection used to sort candidate sites by `getRangeTo` - straight-line distance - and
 * return the nearest. Straight-line distance is a proxy for "can I get there", and in
 * E47N41 the two came apart: a builder at 15,19 sat in a dead-end pocket whose only
 * northward exit was blocked, holding 800 energy for 200 ticks while it reselected the
 * nearest-by-air extension site it could not path to. Clearing its target by hand changed
 * nothing, because the selection reproduced the same choice immediately, and the build
 * lease expiring did not help either - the criterion itself was wrong.
 *
 * `recordUnreachable()` in movement.ts is deliberately not reused here: it is keyed
 * home-room to target-room and requires 50 failures over a sustained window, which is
 * right for abandoning a remote mining route and far too coarse for one tile in one room.
 *
 * Kept separate from Builder.ts, which imports ColonyManager and the movement layer, so
 * the choice can be unit tested - see tests/unit/buildTargets.test.ts.
 */

/**
 * Structure-type build order for home-room sites. Lower is built first.
 *
 * Spawn before anything - a room with no spawn has no future. Containers next, because
 * static mining is what makes everything else affordable, then extensions for spawn
 * capacity, then defence.
 */
export function getHomeSitePriority(site: ConstructionSite): number {
  switch (site.structureType) {
    case STRUCTURE_SPAWN: return 0;
    case STRUCTURE_CONTAINER: return 1;
    case STRUCTURE_EXTENSION: return 2;
    case STRUCTURE_TOWER: return 3;
    case STRUCTURE_STORAGE: return 4;
    case STRUCTURE_LINK: return 4;
    case STRUCTURE_TERMINAL: return 5;
    case STRUCTURE_LAB: return 6;
    case STRUCTURE_WALL: return 7;
    case STRUCTURE_RAMPART: return 7;
    default: return 5;
  }
}

/**
 * The nearest site in this list the creep can actually walk to, or null.
 *
 * Sites in another room cannot be path-tested from here, so they are accepted on trust and
 * reached by room-to-room travel. `ignoreCreeps` is set because a creep standing in the
 * way is a transient condition, not a reason to abandon a site.
 */
export function pickReachableSite(
  creep: Creep,
  sites: ConstructionSite[]
): ConstructionSite | null {
  if (sites.length === 0) return null;

  const here: ConstructionSite[] = [];
  const elsewhere: ConstructionSite[] = [];
  for (const s of sites) {
    if (s.pos.roomName === creep.room.name) here.push(s);
    else elsewhere.push(s);
  }

  if (here.length > 0) {
    // Already within build range of one: pathing to it can return an empty path, which
    // would otherwise read as "unreachable" for a site the creep is standing beside.
    for (const s of here) {
      if (creep.pos.getRangeTo(s) <= 3) return s;
    }
    const closest = creep.pos.findClosestByPath(here, { ignoreCreeps: true });
    if (closest) return closest;
  }

  return elsewhere.length > 0 ? elsewhere[0] : null;
}

/**
 * Choose a home-room site: the best structure-type tier that contains something reachable.
 *
 * Priority is still honoured strictly - an extension is never built before a spawn - but a
 * tier no creep can reach no longer blocks the tiers below it. That combination is the
 * whole point: ordering without a release condition is how a builder came to hold 800
 * energy for 200 ticks in front of a blocked corridor.
 */
export function chooseHomeSite(creep: Creep, sites: ConstructionSite[]): ConstructionSite | null {
  if (sites.length === 0) return null;

  const tiers: Record<number, ConstructionSite[]> = {};
  for (const s of sites) {
    const rank = getHomeSitePriority(s);
    if (!tiers[rank]) tiers[rank] = [];
    tiers[rank].push(s);
  }

  const ranks = Object.keys(tiers)
    .map(Number)
    .sort((a, b) => a - b);

  for (const rank of ranks) {
    const pick = pickReachableSite(creep, tiers[rank]);
    if (pick) return pick;
  }

  return null;
}

/**
 * Walk a list in its existing order and return the first site the creep can reach.
 *
 * For callers whose ordering carries real intent that `findClosestByPath` would discard -
 * RoadBuilder pays out from storage outward, so the nearest road to the creep is not the
 * one it should build. Reachability is still required: that role took `roadSites[0]` after
 * sorting by distance to storage, the same range-as-proxy assumption that stranded the
 * builder in E47N41.
 *
 * Path tests are capped, because each one costs a search and the ordering means the useful
 * candidates are at the front regardless.
 */
export function firstReachable(
  creep: Creep,
  sites: ConstructionSite[],
  limit = 4
): ConstructionSite | null {
  let tested = 0;

  for (const s of sites) {
    // Another room cannot be path-tested from here; accept it and travel.
    if (s.pos.roomName !== creep.room.name) return s;
    if (creep.pos.getRangeTo(s) <= 3) return s;
    if (tested >= limit) break;
    tested++;
    if (creep.pos.findPathTo(s, { ignoreCreeps: true, range: 3 }).length > 0) return s;
  }

  return null;
}
