import { NavLink } from 'react-router-dom';
import type { ColonySummary } from '../../api/colonies';

interface SidebarProps {
  colonies: ColonySummary[];
  loading?: boolean;
}

const navItems = [
  { path: '/', label: 'Empire Overview', icon: '🏛️' },
  { path: '/intel', label: 'Intel Map', icon: '🗺️' },
  { path: '/advisor', label: 'AI Advisor', icon: '🤖' },
  { path: '/recordings', label: 'Recordings', icon: '📹' },
  { path: '/debug', label: 'Debug', icon: '🔧' },
];

export function Sidebar({ colonies, loading }: SidebarProps) {
  return (
    <aside className="w-60 bg-[#1a1a1a] border-r border-[#333] flex flex-col h-screen">
      {/* Logo */}
      <div className="h-12 flex items-center px-4 border-b border-[#333]">
        <h1 className="text-lg font-bold text-[#00ff88]">Screeps Empire</h1>
      </div>

      {/* Navigation */}
      <nav className="py-2">
        {navItems.map((item) => (
          <NavLink
            key={item.path}
            to={item.path}
            className={({ isActive }) =>
              `flex items-center gap-3 px-4 py-2 text-sm transition-colors ${
                isActive
                  ? 'text-[#00ff88] bg-[#222] border-l-2 border-[#00ff88]'
                  : 'text-[#888] hover:text-[#eee] hover:bg-[#222] border-l-2 border-transparent'
              }`
            }
          >
            <span>{item.icon}</span>
            <span>{item.label}</span>
          </NavLink>
        ))}
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
    </aside>
  );
}
