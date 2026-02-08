import { useReducer, useCallback } from 'react';
import type { OverlayState } from './renderFunctions';

export interface PlaybackState {
  // Recording selection
  recordingId: string | null;
  tickList: number[];
  playbackIndex: number;

  // Viewport
  zoom: number;
  panX: number;
  panY: number;

  // Interaction
  dragging: boolean;
  dragStartX: number;
  dragStartY: number;
  lastPanX: number;
  lastPanY: number;
  hoverTile: { x: number; y: number } | null;

  // Playback
  playing: boolean;
  fps: number;

  // Overlays
  overlays: OverlayState;
}

export type PlaybackAction =
  | { type: 'SET_RECORDING'; recordingId: string; tickList: number[] }
  | { type: 'CLEAR_RECORDING' }
  | { type: 'SET_INDEX'; index: number }
  | { type: 'NEXT_FRAME' }
  | { type: 'PREV_FRAME' }
  | { type: 'FIRST_FRAME' }
  | { type: 'LAST_FRAME' }
  | { type: 'TOGGLE_PLAY' }
  | { type: 'STOP' }
  | { type: 'SET_FPS'; fps: number }
  | { type: 'SET_ZOOM'; zoom: number }
  | { type: 'ZOOM_AT'; delta: number; centerX: number; centerY: number }
  | { type: 'PAN_START'; x: number; y: number }
  | { type: 'PAN_MOVE'; x: number; y: number }
  | { type: 'PAN_END' }
  | { type: 'RESET_VIEWPORT' }
  | { type: 'SET_HOVER'; tile: { x: number; y: number } | null }
  | { type: 'TOGGLE_OVERLAY'; overlay: keyof OverlayState };

const initialOverlays: OverlayState = {
  terrain: true,
  structures: true,
  creeps: true,
  heatmap: false,
  oscillations: false,
  roads: false,
  bottlenecks: false,
  stuck: false,
};

const initialState: PlaybackState = {
  recordingId: null,
  tickList: [],
  playbackIndex: 0,
  zoom: 1.0,
  panX: 0,
  panY: 0,
  dragging: false,
  dragStartX: 0,
  dragStartY: 0,
  lastPanX: 0,
  lastPanY: 0,
  hoverTile: null,
  playing: false,
  fps: 10,
  overlays: initialOverlays,
};

function playbackReducer(state: PlaybackState, action: PlaybackAction): PlaybackState {
  switch (action.type) {
    case 'SET_RECORDING':
      return {
        ...state,
        recordingId: action.recordingId,
        tickList: action.tickList,
        playbackIndex: 0,
        playing: false,
        zoom: 1.0,
        panX: 0,
        panY: 0,
      };

    case 'CLEAR_RECORDING':
      return {
        ...state,
        recordingId: null,
        tickList: [],
        playbackIndex: 0,
        playing: false,
      };

    case 'SET_INDEX':
      return {
        ...state,
        playbackIndex: Math.max(0, Math.min(action.index, state.tickList.length - 1)),
      };

    case 'NEXT_FRAME': {
      const nextIndex = state.playbackIndex + 1;
      if (nextIndex >= state.tickList.length) {
        return { ...state, playing: false };
      }
      return { ...state, playbackIndex: nextIndex };
    }

    case 'PREV_FRAME':
      return {
        ...state,
        playbackIndex: Math.max(0, state.playbackIndex - 1),
      };

    case 'FIRST_FRAME':
      return { ...state, playbackIndex: 0 };

    case 'LAST_FRAME':
      return {
        ...state,
        playbackIndex: Math.max(0, state.tickList.length - 1),
      };

    case 'TOGGLE_PLAY':
      return { ...state, playing: !state.playing };

    case 'STOP':
      return { ...state, playing: false };

    case 'SET_FPS':
      return { ...state, fps: Math.max(1, Math.min(30, action.fps)) };

    case 'SET_ZOOM':
      return {
        ...state,
        zoom: Math.max(0.3, Math.min(5.0, action.zoom)),
      };

    case 'ZOOM_AT': {
      const oldZoom = state.zoom;
      const newZoom = Math.max(0.3, Math.min(5.0, oldZoom + action.delta));
      const ratio = newZoom / oldZoom;
      return {
        ...state,
        zoom: newZoom,
        panX: action.centerX - (action.centerX - state.panX) * ratio,
        panY: action.centerY - (action.centerY - state.panY) * ratio,
      };
    }

    case 'PAN_START':
      return {
        ...state,
        dragging: true,
        dragStartX: action.x,
        dragStartY: action.y,
        lastPanX: state.panX,
        lastPanY: state.panY,
      };

    case 'PAN_MOVE':
      if (!state.dragging) return state;
      return {
        ...state,
        panX: state.lastPanX + (action.x - state.dragStartX),
        panY: state.lastPanY + (action.y - state.dragStartY),
      };

    case 'PAN_END':
      return { ...state, dragging: false };

    case 'RESET_VIEWPORT':
      return {
        ...state,
        zoom: 1.0,
        panX: 0,
        panY: 0,
      };

    case 'SET_HOVER':
      return { ...state, hoverTile: action.tile };

    case 'TOGGLE_OVERLAY':
      return {
        ...state,
        overlays: {
          ...state.overlays,
          [action.overlay]: !state.overlays[action.overlay],
        },
      };

    default:
      return state;
  }
}

export function usePlayback() {
  const [state, dispatch] = useReducer(playbackReducer, initialState);

  const getCurrentTick = useCallback(() => {
    if (state.tickList.length === 0) return null;
    return state.tickList[state.playbackIndex];
  }, [state.tickList, state.playbackIndex]);

  const getPreviousTick = useCallback(() => {
    if (state.tickList.length === 0 || state.playbackIndex === 0) return null;
    return state.tickList[state.playbackIndex - 1];
  }, [state.tickList, state.playbackIndex]);

  return {
    state,
    dispatch,
    getCurrentTick,
    getPreviousTick,
  };
}
