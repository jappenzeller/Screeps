import { logger } from "../utils/Logger";
import { ColonyStateManager, CachedColonyState } from "../core/ColonyState";

/**
 * LinkManager - Manages energy transfer between links
 * Uses ColonyState for cached link positions to reduce CPU
 * Links unlock at RCL 5 (2 links), RCL 6 (3), RCL 7 (4), RCL 8 (6)
 *
 * Typical setup:
 * - Source links: Near harvesters, send energy
 * - Controller link: Near controller, receives energy for upgraders
 * - Storage link: Near storage, acts as hub
 */
export class LinkManager {
  private links: StructureLink[] = [];
  private sourceLinks: StructureLink[] = [];
  private controllerLink: StructureLink | null = null;
  private storageLink: StructureLink | null = null;
  private state: CachedColonyState | null = null;

  constructor(private room: Room) {
    // Get links from ColonyState (cached)
    this.state = ColonyStateManager.getState(room.name);

    if (this.state) {
      this.links = this.state.structures.links;
    } else {
      // Fallback
      this.links = room.find(FIND_MY_STRUCTURES, {
        filter: (s) => s.structureType === STRUCTURE_LINK,
      }) as StructureLink[];
    }

    if (this.links.length === 0) return;

    this.categorizeLinks();
  }

  /**
   * Categorize links based on their position
   * Uses cached sources from ColonyState when available
   */
  private categorizeLinks(): void {
    const sources = this.state?.sources ?? this.room.find(FIND_SOURCES);
    const controller = this.room.controller;
    const storage = this.state?.structures.storage ?? this.room.storage;

    for (const link of this.links) {
      // Check if near a source (within 2 tiles)
      const nearSource = sources.some((s) => link.pos.inRangeTo(s, 2));
      if (nearSource) {
        this.sourceLinks.push(link);
        continue;
      }

      // Check if near controller (within 4 tiles)
      if (controller && link.pos.inRangeTo(controller, 4)) {
        this.controllerLink = link;
        continue;
      }

      // Check if near storage (within 2 tiles)
      if (storage && link.pos.inRangeTo(storage, 2)) {
        this.storageLink = link;
        continue;
      }
    }
  }

  run(): void {
    if (this.links.length === 0) return;

    // Transfer from source links to controller/storage links
    for (const sourceLink of this.sourceLinks) {
      // Skip if link is on cooldown or nearly empty
      if (sourceLink.cooldown > 0) continue;
      if (sourceLink.store[RESOURCE_ENERGY] < 400) continue;

      // Priority 1: Send to controller link if it needs energy
      if (this.controllerLink && this.controllerLink.store.getFreeCapacity(RESOURCE_ENERGY) >= 400) {
        const result = sourceLink.transferEnergy(this.controllerLink);
        if (result === OK) {
          logger.debug("LinkManager", `Transferred energy to controller link`);
        }
        continue;
      }

      // Priority 2: Send to storage link if it needs energy
      if (this.storageLink && this.storageLink.store.getFreeCapacity(RESOURCE_ENERGY) >= 400) {
        const result = sourceLink.transferEnergy(this.storageLink);
        if (result === OK) {
          logger.debug("LinkManager", `Transferred energy to storage link`);
        }
        continue;
      }
    }

    // If storage link has energy and controller link needs it, transfer
    if (this.storageLink && this.controllerLink) {
      if (
        this.storageLink.cooldown === 0 &&
        this.storageLink.store[RESOURCE_ENERGY] >= 400 &&
        this.controllerLink.store.getFreeCapacity(RESOURCE_ENERGY) >= 400
      ) {
        this.storageLink.transferEnergy(this.controllerLink);
      }
    }
  }

  /**
   * Get the controller link for upgraders to use
   */
  getControllerLink(): StructureLink | null {
    return this.controllerLink;
  }

  /**
   * Get the storage link for haulers to interact with
   */
  getStorageLink(): StructureLink | null {
    return this.storageLink;
  }

  /**
   * Check if a link is a source link (harvesters should deposit here)
   */
  isSourceLink(link: StructureLink): boolean {
    return this.sourceLinks.includes(link);
  }
}
