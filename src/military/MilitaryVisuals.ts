/**
 * MilitaryVisuals — Draw campaign debug info in target rooms
 *
 * Shows: campaign state, attack progress bar, creep paths, tower ranges
 * Only draws when we have vision on the room.
 */

export function drawMilitaryVisuals(): void {
  var militaryMem = (Memory as any).military;
  if (!militaryMem || !militaryMem.campaigns) return;

  for (var id in militaryMem.campaigns) {
    var campaign = militaryMem.campaigns[id];
    if (campaign.state === "COMPLETE" || campaign.state === "ABORTED") continue;

    var room = Game.rooms[campaign.targetRoom];
    if (!room) continue;

    var visual = room.visual;
    var attack = campaign.controllerAttack;
    if (!attack) continue;

    // --- Campaign header ---
    visual.text(
      "⚔ " + campaign.state + " [" + id + "]",
      1, 1,
      { align: "left", font: "0.7 monospace", color: "#ff4444" }
    );

    // --- Progress bar ---
    var totalTimer = (attack.stats && attack.stats.campaignStartTimer) || 120000;
    var currentTimer = attack.currentTicksToDowngrade || totalTimer;
    var progress = Math.max(0, 1 - (currentTimer / totalTimer));
    var barWidth = 15;
    var barY = 2.2;

    // Background
    visual.rect(1, barY - 0.3, barWidth, 0.6, {
      fill: "#333333", opacity: 0.6
    });
    // Fill
    var fillColor = progress > 0.8 ? "#44ff44" : progress > 0.5 ? "#ffff44" : "#ff4444";
    visual.rect(1, barY - 0.3, barWidth * progress, 0.6, {
      fill: fillColor,
      opacity: 0.8
    });
    // Label
    var estHours = ((attack.estimatedCyclesRemaining || 0) * 1000 / 3600 * 3).toFixed(1);
    visual.text(
      "RCL " + attack.currentTargetRCL + " | " +
      (progress * 100).toFixed(1) + "% | " +
      attack.attackCount + " hits | ~" + estHours + "h",
      1 + barWidth / 2, barY + 0.1,
      { align: "center", font: "0.5 monospace", color: "#ffffff" }
    );

    // --- Controller marker ---
    if (attack.controllerPos && attack.controllerPos.x > 0) {
      visual.circle(attack.controllerPos.x, attack.controllerPos.y, {
        radius: 1.5, fill: "transparent", stroke: "#ff4444",
        strokeWidth: 0.15, opacity: 0.8
      });
      visual.text("TARGET", attack.controllerPos.x, attack.controllerPos.y - 2, {
        font: "0.5 monospace", color: "#ff4444"
      });
    }

    // --- Tower range circles ---
    var towers = room.find(FIND_HOSTILE_STRUCTURES, {
      filter: function(s: Structure) { return s.structureType === STRUCTURE_TOWER; }
    });
    for (var i = 0; i < towers.length; i++) {
      var tower = towers[i] as StructureTower;
      // Optimal range (600 damage)
      visual.circle(tower.pos.x, tower.pos.y, {
        radius: 5, fill: "transparent", stroke: "#ff6600",
        strokeWidth: 0.1, opacity: 0.4, lineStyle: "dashed"
      });
      // Max range (150 damage)
      visual.circle(tower.pos.x, tower.pos.y, {
        radius: 20, fill: "transparent", stroke: "#ff660033",
        strokeWidth: 0.05, opacity: 0.2, lineStyle: "dashed"
      });
      // Energy label
      visual.text(
        "T:" + tower.store[RESOURCE_ENERGY],
        tower.pos.x, tower.pos.y + 1,
        { font: "0.4 monospace", color: "#ff6600" }
      );
    }

    // --- Conquest overlay ---
    var conquest = attack.conquest;
    if (conquest && (campaign.state === "CLAIMING" || campaign.state === "SECURING")) {
      var cY = 4;
      visual.text(
        "CONQUEST: " + conquest.phase,
        1, cY,
        { align: "left", font: "0.6 monospace", color: "#44ff44" }
      );
      visual.text(
        "Structures: " + conquest.structuresRemaining +
        " | Demolishers: " + conquest.demolishersAlive +
        " | Spawns:" + (conquest.spawnsDestroyed ? "Y" : "N") +
        " Towers:" + (conquest.towersDestroyed ? "Y" : "N"),
        1, cY + 1,
        { align: "left", font: "0.45 monospace", color: "#88ff88" }
      );
    }

    // --- Stats footer ---
    var stats = attack.stats;
    if (stats) {
      visual.text(
        "Spawned:" + stats.totalSpawned +
        " Lost:" + stats.totalLost +
        " Energy:" + stats.totalEnergySpent,
        1, 47,
        { align: "left", font: "0.5 monospace", color: "#aaaaaa" }
      );
    }
  }
}
