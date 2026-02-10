/**
 * CampaignEventLog — Persistent event history for campaigns
 *
 * Records key events with timestamps for post-mortem analysis
 * and potential AWS export. Rolling buffer per campaign.
 */

export type EventType =
  | "CAMPAIGN_CREATED"
  | "STATE_CHANGE"
  | "ATTACK_LANDED"
  | "CREEP_LOST"
  | "RCL_DOWNGRADE"
  | "SAFE_MODE"
  | "TOWER_DRAIN_START"
  | "TOWER_DRAIN_END"
  | "ESCORT_REQUESTED"
  | "DEFENDER_DETECTED"
  | "COUNTER_INTEL_ALERT"
  | "CONQUEST_PHASE"
  | "EXPANSION_TRIGGERED"
  | "CAMPAIGN_COMPLETE"
  | "CAMPAIGN_ABORTED";

export interface CampaignEvent {
  tick: number;
  type: EventType;
  detail: string;
  data?: Record<string, any>;
}

var MAX_EVENTS = 200;

/**
 * Get the event log array for a campaign.
 */
function getLog(campaign: any): CampaignEvent[] {
  if (!campaign.controllerAttack) {
    campaign.controllerAttack = {};
  }
  if (!campaign.controllerAttack.eventLog) {
    campaign.controllerAttack.eventLog = [];
  }
  return campaign.controllerAttack.eventLog;
}

/**
 * Add an event to a campaign's log.
 */
export function log(campaign: any, type: EventType, detail: string, data?: Record<string, any>): void {
  var events = getLog(campaign);

  events.push({
    tick: Game.time,
    type: type,
    detail: detail,
    data: data,
  });

  // Trim if over max
  while (events.length > MAX_EVENTS) {
    events.shift();
  }
}

/**
 * Get recent events, optionally filtered by type.
 */
export function getEvents(campaign: any, count?: number, filterType?: EventType): CampaignEvent[] {
  var events = getLog(campaign);
  var filtered = events;

  if (filterType) {
    filtered = [];
    for (var i = 0; i < events.length; i++) {
      if (events[i].type === filterType) {
        filtered.push(events[i]);
      }
    }
  }

  var n = count || 20;
  return filtered.slice(-n);
}

/**
 * Get a timeline summary — one line per event.
 */
export function getTimeline(campaign: any, count?: number): string[] {
  var events = getEvents(campaign, count);
  var lines: string[] = [];

  for (var i = 0; i < events.length; i++) {
    var e = events[i];
    var age = Game.time - e.tick;
    var ageStr: string;
    if (age < 1000) {
      ageStr = age + "t";
    } else if (age < 100000) {
      ageStr = (age / 1000).toFixed(1) + "k";
    } else {
      ageStr = (age / 100000).toFixed(1) + "M";
    }

    // Pad to 6 chars
    while (ageStr.length < 6) {
      ageStr = " " + ageStr;
    }

    // Pad type to 22 chars
    var typeStr = e.type;
    while (typeStr.length < 22) {
      typeStr = typeStr + " ";
    }

    lines.push(ageStr + " ago | " + typeStr + " | " + e.detail);
  }

  return lines;
}
