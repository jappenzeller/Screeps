import { smartMoveTo } from "../utils/movement";
import { LinkManager } from "../structures/LinkManager";

/**
 * LinkFiller - Parks between storage and storage link, keeping the link filled.
 * Tiny creep that withdraws from storage and transfers to storage link.
 * The LinkManager then transfers energy from storage link to controller link.
 */
export function runLinkFiller(creep: Creep): void {
  const storage = creep.room.storage;
  if (!storage) {
    creep.say("no stor");
    return;
  }

  const linkManager = new LinkManager(creep.room);
  const storageLink = linkManager.getStorageLink();

  if (!storageLink) {
    creep.say("no link");
    return;
  }

  // Find or move to parking spot (adjacent to both storage and link)
  const parkingSpot = findParkingSpot(storage, storageLink);
  if (!parkingSpot) {
    creep.say("no spot");
    return;
  }

  if (!creep.pos.isEqualTo(parkingSpot)) {
    smartMoveTo(creep, parkingSpot, { reusePath: 20 });
    creep.say("park");
    return;
  }

  // Parked - alternate withdraw/transfer
  if (creep.store[RESOURCE_ENERGY] === 0) {
    creep.withdraw(storage, RESOURCE_ENERGY);
  } else if (storageLink.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
    creep.transfer(storageLink, RESOURCE_ENERGY);
  }
  // If link is full, just wait (LinkManager will transfer to controller link)
}

/**
 * Find tile adjacent to both storage and link
 */
function findParkingSpot(storage: StructureStorage, link: StructureLink): RoomPosition | null {
  const room = storage.room;
  const terrain = room.getTerrain();

  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      if (dx === 0 && dy === 0) continue;

      const x = storage.pos.x + dx;
      const y = storage.pos.y + dy;

      if (x < 1 || x > 48 || y < 1 || y > 48) continue;
      if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;

      const pos = new RoomPosition(x, y, room.name);
      if (!pos.isNearTo(link)) continue;

      // Check for blocking structures (roads/ramparts/containers are OK)
      const blocking = pos.lookFor(LOOK_STRUCTURES).some(
        (s) =>
          s.structureType !== STRUCTURE_ROAD &&
          s.structureType !== STRUCTURE_RAMPART &&
          s.structureType !== STRUCTURE_CONTAINER
      );
      if (blocking) continue;

      return pos;
    }
  }
  return null;
}
