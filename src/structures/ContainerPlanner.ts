/**
 * ContainerPlanner: Automatically places container construction sites
 * - Source containers: Adjacent to each energy source (side closest to spawn)
 * - Controller container: 2-3 tiles from controller for upgraders
 */

import { logger } from "../utils/Logger";

// ContainerPlan interface is defined in types.d.ts

export class ContainerPlanner {
  constructor(private room: Room) {}

  /**
   * Run container planning - call periodically (every 10-50 ticks)
   */
  run(): void {
    // Containers unlock at RCL 2
    if (!this.room.controller || this.room.controller.level < 2) {
      return;
    }

    // Initialize room memory
    if (!Memory.rooms) Memory.rooms = {};
    if (!Memory.rooms[this.room.name]) Memory.rooms[this.room.name] = {};

    // Get or create container plan
    let plan = Memory.rooms[this.room.name].containerPlan as ContainerPlan | undefined;
    if (!plan) {
      plan = this.createPlan();
      Memory.rooms[this.room.name].containerPlan = plan;
      logger.info("ContainerPlanner", `Created container plan for ${this.room.name}`);
    }

    // Always try to place sites - check each position individually
    // This handles cases where some containers built but others failed
    this.placeConstructionSites(plan);
  }

  private createPlan(): ContainerPlan {
    const plan: ContainerPlan = {
      sources: {},
    };

    const spawn = this.room.find(FIND_MY_SPAWNS)[0];
    const sources = this.room.find(FIND_SOURCES);

    // Plan container for each source
    for (const source of sources) {
      const pos = this.findBestContainerPosition(source, spawn);
      if (pos) {
        plan.sources[source.id] = { x: pos.x, y: pos.y };
      }
    }

    // Plan container near controller (RCL 5+ with storage only)
    // At low RCL, controller containers waste builder time - upgraders should get energy from haulers
    if (this.room.controller && this.room.controller.level >= 5 && this.room.storage) {
      const controllerPos = this.findControllerContainerPosition();
      if (controllerPos) {
        plan.controller = { x: controllerPos.x, y: controllerPos.y };
      }
    }

    return plan;
  }

  /**
   * Find the best position for a source container
   * Prefers: Adjacent to source, closest to spawn, walkable terrain
   */
  private findBestContainerPosition(source: Source, spawn: StructureSpawn | undefined): RoomPosition | null {
    const terrain = this.room.getTerrain();
    const candidates: { pos: RoomPosition; distance: number }[] = [];

    // Check all 8 adjacent tiles
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy === 0) continue;

        const x = source.pos.x + dx;
        const y = source.pos.y + dy;

        // Skip if out of bounds
        if (x < 1 || x > 48 || y < 1 || y > 48) continue;

        // Skip walls
        if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;

        // Skip if structure already exists
        const structures = this.room.lookForAt(LOOK_STRUCTURES, x, y);
        const hasBlockingStructure = structures.some(
          (s) => s.structureType !== STRUCTURE_ROAD && s.structureType !== STRUCTURE_RAMPART
        );
        if (hasBlockingStructure) continue;

        // Skip if container already exists here
        const hasContainer = structures.some((s) => s.structureType === STRUCTURE_CONTAINER);
        if (hasContainer) continue;

        const pos = new RoomPosition(x, y, this.room.name);
        const distance = spawn ? pos.getRangeTo(spawn) : 0;
        candidates.push({ pos, distance });
      }
    }

    if (candidates.length === 0) return null;

    // Sort by distance to spawn (prefer closer)
    candidates.sort((a, b) => a.distance - b.distance);
    return candidates[0].pos;
  }

  /**
   * Find position for controller container
   * Should be 2-3 tiles from controller, accessible
   */
  private findControllerContainerPosition(): RoomPosition | null {
    const controller = this.room.controller;
    if (!controller) return null;

    const terrain = this.room.getTerrain();
    const spawn = this.room.find(FIND_MY_SPAWNS)[0];
    const candidates: { pos: RoomPosition; distance: number }[] = [];

    // Check tiles 2-3 range from controller
    for (let dx = -3; dx <= 3; dx++) {
      for (let dy = -3; dy <= 3; dy++) {
        const range = Math.max(Math.abs(dx), Math.abs(dy));
        if (range < 2 || range > 3) continue;

        const x = controller.pos.x + dx;
        const y = controller.pos.y + dy;

        if (x < 1 || x > 48 || y < 1 || y > 48) continue;
        if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;

        // Skip if structure already exists
        const structures = this.room.lookForAt(LOOK_STRUCTURES, x, y);
        const hasBlockingStructure = structures.some(
          (s) => s.structureType !== STRUCTURE_ROAD && s.structureType !== STRUCTURE_RAMPART
        );
        if (hasBlockingStructure) continue;

        const hasContainer = structures.some((s) => s.structureType === STRUCTURE_CONTAINER);
        if (hasContainer) continue;

        const pos = new RoomPosition(x, y, this.room.name);
        const distance = spawn ? pos.getRangeTo(spawn) : 0;
        candidates.push({ pos, distance });
      }
    }

    if (candidates.length === 0) return null;

    // Prefer position closer to spawn for hauler efficiency
    candidates.sort((a, b) => a.distance - b.distance);
    return candidates[0].pos;
  }

  /**
   * Place construction sites for planned containers
   * Idempotent - safe to call repeatedly, will skip already placed
   */
  private placeConstructionSites(plan: ContainerPlan): void {
    // Place source containers
    for (const sourceId in plan.sources) {
      const pos = plan.sources[sourceId];
      this.placeContainerSite(pos.x, pos.y);
    }

    // Place controller container (RCL 5+ with storage only)
    // This check handles old plans that may have controller position from before this fix
    if (plan.controller && this.room.controller && this.room.controller.level >= 5 && this.room.storage) {
      this.placeContainerSite(plan.controller.x, plan.controller.y);
    }
  }

  /**
   * Place a single container construction site
   */
  private placeContainerSite(x: number, y: number): ScreepsReturnCode {
    // Check if container or construction site already exists
    const structures = this.room.lookForAt(LOOK_STRUCTURES, x, y);
    const hasContainer = structures.some((s) => s.structureType === STRUCTURE_CONTAINER);
    if (hasContainer) return OK;

    const sites = this.room.lookForAt(LOOK_CONSTRUCTION_SITES, x, y);
    const hasSite = sites.some((s) => s.structureType === STRUCTURE_CONTAINER);
    if (hasSite) return OK;

    // Place construction site
    const result = this.room.createConstructionSite(x, y, STRUCTURE_CONTAINER);
    if (result === OK) {
      logger.debug("ContainerPlanner", `Placed container site at ${x},${y}`);
    } else if (result !== ERR_FULL) {
      logger.warn("ContainerPlanner", `Failed to place container at ${x},${y}: ${result}`);
    }
    return result;
  }

  /**
   * Check if a source has a container nearby
   */
  static getSourceContainer(source: Source): StructureContainer | null {
    const containers = source.pos.findInRange(FIND_STRUCTURES, 1, {
      filter: (s) => s.structureType === STRUCTURE_CONTAINER,
    }) as StructureContainer[];
    return containers.length > 0 ? containers[0] : null;
  }

  /**
   * Check if controller has a container nearby
   */
  static getControllerContainer(room: Room): StructureContainer | null {
    if (!room.controller) return null;
    const containers = room.controller.pos.findInRange(FIND_STRUCTURES, 3, {
      filter: (s) => s.structureType === STRUCTURE_CONTAINER,
    }) as StructureContainer[];
    return containers.length > 0 ? containers[0] : null;
  }
}
