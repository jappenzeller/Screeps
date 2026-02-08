import { SHORTCUTS } from '../hooks/useKeyboardShortcuts';

interface KeyboardShortcutsModalProps {
  open: boolean;
  onClose: () => void;
}

export function KeyboardShortcutsModal({ open, onClose }: KeyboardShortcutsModalProps) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/70"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Modal */}
      <div className="relative bg-[#1a1a1a] border border-[#333] rounded-lg shadow-xl max-w-md w-full mx-4 max-h-[80vh] overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-[#333]">
          <h2 className="text-lg font-semibold text-[#eee]">Keyboard Shortcuts</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-[#888] hover:text-[#eee] p-1"
            aria-label="Close"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="p-4 overflow-y-auto max-h-[60vh]">
          <div className="grid gap-2">
            {SHORTCUTS.map((shortcut) => (
              <div key={shortcut.key} className="flex items-center gap-3">
                <kbd className="min-w-[60px] px-2 py-1 bg-[#333] border border-[#444] rounded text-sm text-[#eee] text-center font-mono">
                  {shortcut.key}
                </kbd>
                <span className="text-sm text-[#ccc]">{shortcut.description}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-[#333] text-xs text-[#666]">
          Press <kbd className="px-1 py-0.5 bg-[#333] rounded">Esc</kbd> to close
        </div>
      </div>
    </div>
  );
}
