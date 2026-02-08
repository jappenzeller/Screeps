export const API_BASE = 'https://dossn1w7n5.execute-api.us-east-1.amazonaws.com';

export const POLL_INTERVALS = {
  COLONIES: 30_000,
  EMPIRE: 60_000,
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
