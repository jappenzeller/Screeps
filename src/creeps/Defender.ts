import { ColonyManager } from "../core/ColonyManager";

/**
 * Defender - Attacks hostile creeps in the room
 * Uses ColonyManager DEFEND tasks for target coordination
 */
export function runDefender(creep: Creep): void {
  const manager = ColonyManager.getInstance(creep.memory.room);

  // Task tracking - validate existing task
  if (creep.memory.taskId) {
    const tasks = manager.getTasks();
    const myTask = tasks.find((t) => t.id === creep.memory.taskId);

    if (myTask && myTask.type === "DEFEND") {
      // Check if target still exists
      const target = Game.getObjectById(myTask.targetId as Id<Creep>);
      if (!target) {
        // Target eliminated - complete task
        manager.completeTask(creep.memory.taskId);
        delete creep.memory.taskId;
      }
    } else if (!myTask) {
      // Task no longer exists
      delete creep.memory.taskId;
    }
  }

  // Request DEFEND task if we don't have one
  if (!creep.memory.taskId) {
    const task = manager.getAvailableTask(creep);
    if (task && task.type === "DEFEND") {
      manager.assignTask(task.id, creep.name);
      creep.memory.taskId = task.id;
    }
  }

  // Get target from task
  let target: Creep | null = null;
  if (creep.memory.taskId) {
    const tasks = manager.getTasks();
    const myTask = tasks.find((t) => t.id === creep.memory.taskId);
    if (myTask) {
      target = Game.getObjectById(myTask.targetId as Id<Creep>);
    }
  }

  // Execute defense
  if (target) {
    const attackResult = creep.attack(target);
    if (attackResult === ERR_NOT_IN_RANGE) {
      creep.moveTo(target, { visualizePathStyle: { stroke: "#ff0000" }, reusePath: 3 });
    }
    // Also use ranged attack if we have it
    if (creep.getActiveBodyparts(RANGED_ATTACK) > 0) {
      creep.rangedAttack(target);
    }
  } else {
    // No target - patrol near spawn
    const spawn = creep.pos.findClosestByPath(FIND_MY_SPAWNS);
    if (spawn && creep.pos.getRangeTo(spawn) > 5) {
      creep.moveTo(spawn, { visualizePathStyle: { stroke: "#ff0000" } });
    }
  }
}
