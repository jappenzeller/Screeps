import { useEffect, useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';

interface KeyboardShortcutsOptions {
  onShowHelp: () => void;
  onEscape?: () => void;
  onRefresh?: () => void;
}

function isInputFocused(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || (el as HTMLElement).isContentEditable;
}

export function useKeyboardShortcuts({
  onShowHelp,
  onEscape,
  onRefresh,
}: KeyboardShortcutsOptions) {
  const navigate = useNavigate();
  const location = useLocation();

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    // Skip if user is typing in an input
    if (isInputFocused()) return;

    switch (e.key) {
      case '1':
        navigate('/');
        break;
      case '2':
        navigate('/intel');
        break;
      case '3':
        navigate('/military');
        break;
      case '4':
        navigate('/advisor');
        break;
      case '5':
        navigate('/recordings');
        break;
      case '6':
        navigate('/debug');
        break;
      case '?':
        e.preventDefault();
        onShowHelp();
        break;
      case 'Escape':
        e.preventDefault();
        onEscape?.();
        break;
      case 'r':
        if (!e.ctrlKey && !e.metaKey) {
          e.preventDefault();
          onRefresh?.();
        }
        break;
      // Recording-specific shortcuts are handled in Recordings.tsx
      default:
        break;
    }
  }, [navigate, onShowHelp, onEscape, onRefresh]);

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  return { location };
}

// Shortcut definitions for help modal
export const SHORTCUTS = [
  { key: '1', description: 'Go to Empire Overview' },
  { key: '2', description: 'Go to Intel Map' },
  { key: '3', description: 'Go to Military' },
  { key: '4', description: 'Go to AI Advisor' },
  { key: '5', description: 'Go to Recordings' },
  { key: '6', description: 'Go to Debug Console' },
  { key: '?', description: 'Show keyboard shortcuts' },
  { key: 'Esc', description: 'Close panels/modals' },
  { key: 'r', description: 'Refresh current data' },
  { key: 'Space', description: 'Play/pause (Recordings)' },
  { key: '← →', description: 'Prev/next frame (Recordings)' },
  { key: 'Home/End', description: 'First/last frame (Recordings)' },
];
