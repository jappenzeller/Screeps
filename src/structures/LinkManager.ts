import { logger } from "../utils/Logger";
import { ColonyStateManager, CachedColonyState } from "../core/ColonyState";
import * as Liveness from "../core/Liveness";

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
      // Check if near a source (within 2 tiles) - these SEND energy
      const nearSource = sources.some((s) => link.pos.inRangeTo(s, 2));
      if (nearSource) {
        this.sourceLinks.push(link);
        continue;
      }

      // Check storage BEFORE controller (storage has stricter range, and controller range 4 might overlap)
      // Storage link is the hub for colony distribution
      if (storage && link.pos.inRangeTo(storage, 2)) {
        this.storageLink = link;
        continue;
      }

      // Check if near controller (within 4 tiles) - receives energy for upgraders
      if (controller && link.pos.inRangeTo(controller, 4)) {
        this.controllerLink = link;
        continue;
      }
    }
  }

  run(): void {
    Liveness.ran("LinkManager");

    // This is the system with a recorded silent failure already: E43N39 sat at 1,430/1,800
    // spawn energy - 79.4% against a 0.8 threshold - so harvesters never once fed a link,
    // and the entire network stayed dark with a storage link built for it. Nothing logged.
    if (this.links.length === 0) {
      Liveness.idle("LinkManager");
      return;
    }

    let moved = false;

    // Transfer from source links to controller/storage links
    for (const sourceLink of this.sourceLinks) {
      // Skip if link is on cooldown or nearly empty
      if (sourceLink.cooldown > 0) continue;
      if (sourceLink.store[RESOURCE_ENERGY] < 100) continue;

      // Priority 1: Send to storage link (hub for colony distribution)
      if (this.storageLink && this.storageLink.store.getFreeCapacity(RESOURCE_ENERGY) >= 100) {
        // Result checked rather than assumed: counting an attempt as work would make the
        // registry report a permanently failing transfer as a healthy one.
        if (sourceLink.transferEnergy(this.storageLink) === OK) {
          Liveness.acted("LinkManager");
          moved = true;
        }
        continue;
      }

      // Priority 2: Send to controller link only if storage link is full
      if (this.controllerLink && this.controllerLink.store.getFreeCapacity(RESOURCE_ENERGY) >= 100) {
        if (sourceLink.transferEnergy(this.controllerLink) === OK) {
          Liveness.acted("LinkManager");
          moved = true;
        }
        continue;
      }
    }

    // Transfer from storage link to controller link ONLY when colony is satisfied
    if (this.storageLink && this.controllerLink) {
      if (
        this.storageLink.cooldown === 0 &&
        this.storageLink.store[RESOURCE_ENERGY] >= 100 &&
        this.controllerLink.store.getFreeCapacity(RESOURCE_ENERGY) >= 100
      ) {
        // Gate: only send to controller when storage has healthy reserves
        // Storage level is the real indicator of colony health, not extension fill state.
        // Extensions are transient (filler handles them), storage is the buffer.
        var storage = this.room.storage;
        var storageEnergy = storage ? storage.store[RESOURCE_ENERGY] : 0;
        if (storageEnergy > 10000) {
          if (this.storageLink.transferEnergy(this.controllerLink) === OK) {
            Liveness.acted("LinkManager");
            moved = true;
          }
        }
      }
    }

    // Links on cooldown, or below the 100-energy floor, or a storage bank under 10,000:
    // all correct reasons to move nothing this tick.
    if (!moved) Liveness.idle("LinkManager");
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
