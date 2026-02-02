/**
 * Empire module - Centralized empire management
 * Per empire-architecture.md
 */

export { eventBus, EmpireEventType, EmpireEvent } from "./EventBus";
export { getConfig, DEFAULT_CONFIG, EmpireConfig, ExpansionConfig } from "./EmpireConfig";
export {
  initializeEmpireMemory,
  EmpireExpansionState,
  EmpireExpansionHistory,
  ExpansionStateType,
  EmpireStateType,
} from "./EmpireMemory";
export { SpawnPlacementCalculator, PlacementResult } from "./SpawnPlacementCalculator";
export { ExpansionManager, expansion } from "./ExpansionManager";
export { RoomEvaluator, RoomScore } from "./RoomEvaluator";
export { ExpansionReadiness, ReadinessCheck, ParentCandidate } from "./ExpansionReadiness";
