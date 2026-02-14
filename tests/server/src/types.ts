/**
 * Type Definitions for Private Server Test Infrastructure
 */

import { BodyPartType, StructureType } from "./constants";

// ============================================
// Server Controller Types
// ============================================

export interface ServerControllerConfig {
  /** Port to run the server on (default: 21025) */
  port?: number;
  /** Whether to log bot console output (default: false) */
  logConsole?: boolean;
  /** Whether to capture memory each tick (default: false) */
  captureMemory?: boolean;
  /** Path to store server data */
  dataDir?: string;
}

export interface BotHandle {
  /** Username of the bot */
  username: string;
  /** Room where the bot started */
  startRoom: string;
  /** Console output captured from this bot */
  consoleLogs: string[];
}

// ============================================
// World Builder Types
// ============================================

export interface Position {
  x: number;
  y: number;
}

export interface SourceConfig {
  x: number;
  y: number;
  energy?: number;
}

export interface MineralConfig {
  x: number;
  y: number;
  mineralType: string;
  density?: number;
}

// ============================================
// Scenario Configuration Types
// ============================================

export interface ScenarioConfig {
  /** Unique name for this scenario */
  name: string;
  /** Description of what this scenario tests */
  description: string;
  /** Category for grouping (economic, combat, expansion, etc.) */
  category?: string;

  // World setup
  /** Rooms to create for this scenario */
  rooms: RoomConfig[];

  // Bot configuration
  /** Our main bot configuration */
  bot: BotConfig;
  /** Optional hostile bots */
  hostileBots?: HostileBotConfig[];

  // Test parameters
  /** Maximum ticks to run the scenario */
  tickLimit: number;
  /** How often to check assertions (default: 100) */
  checkInterval?: number;
  /** If true, fail fast on first assertion failure */
  bailOnFailure?: boolean;

  // Assertions
  /** Success/failure conditions to check */
  assertions: Assertion[];

  // Event injections (optional)
  /** Events to inject at specific ticks */
  injections?: InjectionConfig[];
}

export interface RoomConfig {
  /** Room name (e.g., "W0N1") */
  name: string;

  // Room ownership
  /** Owner username (null = unowned) */
  owner?: string | null;
  /** Controller level (if owned) */
  rcl?: number;

  // Terrain
  /** Terrain type: 'random', 'open', or base64 terrain data */
  terrain?: "random" | "open" | string;

  // Controller
  /** Controller position (required for owned rooms) */
  controllerPos?: Position;
  /** Initial ticks to downgrade */
  ticksToDowngrade?: number;
  /** Number of safe modes available */
  safeModesAvailable?: number;

  // Sources
  /** Source positions and initial energy */
  sources?: SourceConfig[];

  // Mineral (optional)
  /** Mineral configuration */
  mineral?: MineralConfig;

  // Structures to place
  /** Structures to pre-place in this room */
  structures?: StructurePlacement[];

  // Resources in storage/terminal
  /** Initial storage contents */
  storage?: Record<string, number>;
  /** Initial terminal contents */
  terminalResources?: Record<string, number>;

  // Pre-spawned hostile creeps
  /** Static hostile creeps to place */
  hostileCreeps?: StaticCreepConfig[];
}

export interface StructurePlacement {
  /** Structure type */
  type: StructureType;
  /** X position */
  x: number;
  /** Y position */
  y: number;
  /** Owner username (for owned structures) */
  owner?: string;
  /** Initial hits (for ramparts/walls) */
  hits?: number;
  /** Initial energy (for towers/spawns/extensions) */
  energy?: number;
  /** Initial store contents */
  store?: Record<string, number>;
}

export interface StaticCreepConfig {
  /** Body parts */
  body: BodyPartType[];
  /** X position */
  x: number;
  /** Y position */
  y: number;
  /** Owner username (default: 'Invader') */
  owner?: string;
  /** Initial memory */
  memory?: Record<string, unknown>;
}

export interface BotConfig {
  /** Username for our bot */
  username: string;
  /** Starting room name */
  room: string;
  /** Starting RCL */
  rcl: number;
  /** GCL level (default: 1) */
  gcl?: number;
  /** CPU limit (default: 100) */
  cpu?: number;
  /** Initial energy in spawn/extensions */
  energy?: number;
  /** Initial storage energy */
  storageEnergy?: number;

  // Pre-place structures
  /** Structures to place for our bot */
  structures?: StructurePlacement[];

  // Pre-spawn creeps
  /** Initial creeps to spawn for our bot */
  initialCreeps?: InitialCreepConfig[];
}

export interface InitialCreepConfig {
  /** Creep role */
  role: string;
  /** Body parts */
  body: BodyPartType[];
  /** X position */
  x: number;
  /** Y position */
  y: number;
  /** Initial memory */
  memory?: Record<string, unknown>;
  /** Ticks to live (default: 1500) */
  ticksToLive?: number;
}

export interface HostileBotConfig {
  /** Username for the hostile bot */
  username: string;
  /** Starting room name */
  room: string;
  /** Starting position in the room */
  position?: Position;
  /** RCL for the hostile bot */
  rcl?: number;
  /** Behavior configuration */
  behavior: HostileBehavior;
  /** Creep bodies to spawn */
  bodies?: BodyPartType[][];
  /** Pre-placed structures */
  structures?: StructurePlacement[];
}

export interface HostileBehavior {
  /** Behavior mode */
  mode: "attack" | "harass" | "defend" | "siege" | "passive";
  /** Primary target type */
  primaryTarget?: "creeps" | "structures" | "spawn" | "storage" | "controller";
  /** Target room (if different from spawn room) */
  targetRoom?: string;
  /** HP percentage to retreat at */
  retreatThreshold?: number;
  /** Ticks to wait before respawning */
  respawnDelay?: number;
  /** Whether to use towers offensively */
  useTowers?: boolean;
  /** Whether to repair structures */
  repairStructures?: boolean;
}

// ============================================
// Assertion Types
// ============================================

export type AssertionTiming = "end" | "continuous" | "after_tick";

export interface Assertion {
  /** Assertion type */
  type:
    | "room_owned_by"
    | "room_rcl_above"
    | "room_rcl_below"
    | "creep_count_above"
    | "creep_count_below"
    | "structure_exists"
    | "structure_destroyed"
    | "storage_above"
    | "storage_below"
    | "no_hostile_creeps"
    | "no_hostile_structures"
    | "bot_survived"
    | "custom";

  /** Target room (if applicable) */
  room?: string;
  /** Target value or identifier */
  target?: string;
  /** Numeric value for comparison */
  value?: number;

  /** When to check this assertion */
  timing: AssertionTiming;
  /** Specific tick to check at (for 'after_tick' timing) */
  afterTick?: number;

  /** Human-readable description */
  description?: string;

  /** Custom assertion function (for 'custom' type) */
  customFn?: (state: GameState) => AssertionResult;
}

export interface AssertionResult {
  /** Whether the assertion passed */
  passed: boolean;
  /** Human-readable message */
  message: string;
  /** Actual value found */
  actual?: unknown;
  /** Expected value */
  expected?: unknown;
  /** Tick when this was checked */
  tick?: number;
}

// ============================================
// Game State Types
// ============================================

export interface GameState {
  /** Current game tick */
  tick: number;
  /** Room states */
  rooms: Map<string, RoomState>;
  /** Bot memory snapshots */
  memory: Map<string, unknown>;
  /** Console logs by bot username */
  consoleLogs: Map<string, string[]>;
}

export interface RoomState {
  /** Room name */
  name: string;
  /** Owner username (null if unowned) */
  owner: string | null;
  /** Controller level */
  rcl: number | null;
  /** Ticks until downgrade */
  ticksToDowngrade?: number;
  /** All objects in the room */
  objects: RoomObject[];
  /** Creeps in the room */
  creeps: CreepState[];
  /** Structures in the room */
  structures: StructureState[];
}

export interface RoomObject {
  /** Object ID */
  id: string;
  /** Object type */
  type: string;
  /** X position */
  x: number;
  /** Y position */
  y: number;
  /** Additional properties */
  [key: string]: unknown;
}

export interface CreepState {
  /** Creep ID */
  id: string;
  /** Creep name */
  name: string;
  /** Owner username */
  owner: string;
  /** Body parts */
  body: BodyPartType[];
  /** Current hits */
  hits: number;
  /** Max hits */
  hitsMax: number;
  /** X position */
  x: number;
  /** Y position */
  y: number;
  /** Creep role (from memory) */
  role?: string;
  /** Ticks to live */
  ticksToLive?: number;
  /** Creep memory */
  memory?: Record<string, unknown>;
}

export interface StructureState {
  /** Structure ID */
  id: string;
  /** Structure type */
  type: StructureType;
  /** Owner username (null for neutral) */
  owner: string | null;
  /** Current hits */
  hits: number;
  /** Max hits */
  hitsMax: number;
  /** X position */
  x: number;
  /** Y position */
  y: number;
  /** Store contents (if applicable) */
  store?: Record<string, number>;
}

// ============================================
// Scenario Result Types
// ============================================

export interface ScenarioResult {
  /** Scenario name */
  scenario: string;
  /** Whether all assertions passed */
  passed: boolean;
  /** Total duration in milliseconds */
  duration: number;
  /** Number of ticks run */
  ticksRun: number;
  /** Individual assertion results */
  assertions: AssertionResult[];
  /** Errors encountered during execution */
  errors: string[];
  /** Timeline of key events */
  timeline: TimelineEvent[];
  /** Final game state */
  finalState?: GameState;
}

export interface TimelineEvent {
  /** Tick when event occurred */
  tick: number;
  /** Event type */
  type:
    | "scenario_start"
    | "scenario_end"
    | "bot_deployed"
    | "assertion_checked"
    | "assertion_failed"
    | "injection"
    | "creep_spawn"
    | "creep_death"
    | "structure_destroyed"
    | "error"
    | "custom";
  /** Event description */
  description: string;
  /** Additional data */
  data?: Record<string, unknown>;
}

// ============================================
// Injection Types
// ============================================

export interface InjectionConfig {
  /** Tick at which to inject */
  tick: number;
  /** Type of injection */
  type: "kill_creeps" | "damage_structures" | "add_energy" | "spawn_hostiles" | "custom";
  /** Target room */
  room?: string;
  /** Filter for targets (e.g., role name for creeps) */
  filter?: string;
  /** Value (damage amount, energy amount, etc.) */
  value?: number;
  /** Custom injection function */
  customFn?: (state: GameState) => Promise<void>;
  /** Description */
  description?: string;
}

// ============================================
// CLI Types
// ============================================

export interface CLIArgs {
  /** Run all scenarios */
  all?: boolean;
  /** Run specific scenario by name */
  scenario?: string;
  /** Run scenarios in a category */
  category?: string;
  /** Verbose output */
  verbose?: boolean;
  /** Stop on first failure */
  bail?: boolean;
  /** Quick mode (reduced tick limits) */
  quick?: boolean;
  /** Output results to file */
  output?: string;
}
