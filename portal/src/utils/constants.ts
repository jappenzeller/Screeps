export const API_BASE = 'https://g9gplzbul4.execute-api.us-east-1.amazonaws.com';

export const POLL_INTERVALS = {
  COLONIES: 30_000,
  COLONY_DETAIL: 15_000,
  COLONY_ECONOMY: 30_000,
  EMPIRE: 60_000,
  MILITARY: 15_000, // Military campaigns update frequently
  METRICS: 0, // on-demand only
  ANALYSIS: 120_000,
  RECORDINGS: 0,
};

export const COLORS = {
  bg: {
    primary: '#111111',
    secondary: '#1a1a1a',
    tertiary: '#222222',
  },
  text: {
    primary: '#eeeeee',
    secondary: '#888888',
  },
  accent: {
    green: '#00ff88',
    blue: '#4488ff',
    yellow: '#ffcc00',
    red: '#ff4444',
    purple: '#aa88ff',
  },
  border: '#333333',
};

export const ROLE_COLORS: Record<string, string> = {
  HARVESTER: '#00ff88',
  HAULER: '#ffcc00',
  UPGRADER: '#4488ff',
  BUILDER: '#ff8844',
  DEFENDER: '#ff4444',
  REMOTE_MINER: '#00cc66',
  REMOTE_HAULER: '#ccaa00',
  RESERVER: '#aa88ff',
  REMOTE_DEFENDER: '#cc3333',
  LINK_FILLER: '#88ccff',
  MINERAL_HARVESTER: '#ff88ff',
  SCOUT: '#888888',
  CLAIMER: '#ff44ff',
  BOOTSTRAP_BUILDER: '#ff6600',
  BOOTSTRAP_HAULER: '#cc8800',
  // Military roles
  CONTROLLER_ATTACKER: '#ff0066',
  DECOY: '#ff8800',
  DEMOLISHER: '#cc0000',
  RECLAIM_BLOCKER: '#9900ff',
};

export const BODY_PART_COLORS: Record<string, string> = {
  work: '#FFE56D',
  carry: '#777777',
  move: '#A9B7C6',
  attack: '#F93842',
  ranged_attack: '#5D80B2',
  heal: '#65FD62',
  tough: '#FFFFFF',
  claim: '#B99CFB',
};

export const BODY_PART_SHORT: Record<string, string> = {
  work: 'W',
  carry: 'C',
  move: 'M',
  attack: 'A',
  ranged_attack: 'R',
  heal: 'H',
  tough: 'T',
  claim: 'CL',
};
