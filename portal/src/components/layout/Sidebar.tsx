import { NavLink } from 'react-router-dom';
import type { ColonySummary } from '../../api/colonies';

interface SidebarProps {
  colonies: ColonySummary[];
  loading?: boolean;
  open: boolean;
  onClose: () => void;
  badges?: {
    intel?: number;
    advisor?: number;
    recordings?: number;
  };
}

const navItems = [
  { path: '/', label: 'Empire Overview', icon: '🏛️', key: 'overview' },
  { path: '/intel', label: 'Intel Map', icon: '🗺️', key: 'intel' },
  { path: '/advisor', label: 'AI Advisor', icon: '🤖', key: 'advisor' },
  { path: '/recordings', label: 'Recordings', icon: '📹', key: 'recordings' },
  { path: '/debug', label: 'Debug', icon: '🔧', key: 'debug' },
];

export function Sidebar({ colonies, loading, open, onClose, badges }: SidebarProps) {
  const handleNavClick = () => {
    // Close sidebar on mobile when navigating
    if (window.innerWidth < 1024) {
      onClose();
    }
  };

  return (
    <>
      {/* Backdrop for mobile */}
      {open && (
        <div
          className="fixed inset-0 bg-black/50 z-40 lg:hidden"
          onClick={onClose}
          aria-hidden="true"
        />
      )}

      {/* Sidebar */}
      <aside
        className={`
          fixed lg:static inset-y-0 left-0 z-50
          w-60 bg-[#1a1a1a] border-r border-[#333] flex flex-col h-screen
          transform transition-transform duration-200 ease-in-out
          ${open ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}
        `}
      >
        {/* Logo */}
        <div className="h-12 flex items-center justify-between px-4 border-b border-[#333]">
          <h1 className="text-lg font-bold text-[#00ff88]">Screeps Empire</h1>
          {/* Close button for mobile */}
          <button
            type="button"
            onClick={onClose}
            className="lg:hidden text-[#888] hover:text-[#eee] p-1"
            aria-label="Close sidebar"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Navigation */}
        <nav className="py-2">
          {navItems.map((item) => {
            const badge = badges?.[item.key as keyof typeof badges];
            return (
              <NavLink
                key={item.path}
                to={item.path}
                onClick={handleNavClick}
                className={({ isActive }) =>
                  `flex items-center gap-3 px-4 py-2 text-sm transition-colors ${
                    isActive
                      ? 'text-[#00ff88] bg-[#222] border-l-2 border-[#00ff88]'
                      : 'text-[#888] hover:text-[#eee] hover:bg-[#222] border-l-2 border-transparent'
                  }`
                }
              >
                <span>{item.icon}</span>
                <span className="flex-1">{item.label}</span>
                {badge !== undefined && badge > 0 && (
                  <span className="text-xs text-[#4488ff] bg-[#4488ff22] px-1.5 py-0.5 rounded">
                    {badge}
                  </span>
                )}
              </NavLink>
            );
          })}
        </nav>

        {/* Divider */}
        <div className="mx-4 my-2 border-t border-[#333]" />

        {/* Colony List */}
        <div className="flex-1 overflow-y-auto">
          <div className="px-4 py-2 text-xs text-[#666] uppercase tracking-wider">
            Colonies
          </div>
          {loading ? (
            <div className="px-4 py-2 text-sm text-[#666]">Loading...</div>
          ) : colonies.length === 0 ? (
            <div className="px-4 py-2 text-sm text-[#666]">No colonies</div>
          ) : (
            colonies.map((colony) => (
              <NavLink
                key={colony.roomName}
                to={`/colony/${colony.roomName}`}
                onClick={handleNavClick}
                className={({ isActive }) =>
                  `flex items-center justify-between px-4 py-2 text-sm transition-colors ${
                    isActive
                      ? 'text-[#00ff88] bg-[#222] border-l-2 border-[#00ff88]'
                      : 'text-[#ccc] hover:text-[#eee] hover:bg-[#222] border-l-2 border-transparent'
                  }`
                }
              >
                <span>{colony.roomName}</span>
                <span className="text-[#4488ff] text-xs">RCL {colony.rcl}</span>
              </NavLink>
            ))
          )}
        </div>

        {/* Keyboard shortcut hint */}
        <div className="p-4 border-t border-[#333]">
          <div className="text-xs text-[#666]">
            Press <kbd className="px-1 py-0.5 bg-[#333] rounded text-[#888]">?</kbd> for shortcuts
          </div>
        </div>
      </aside>
    </>
  );
}
