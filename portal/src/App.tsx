import { useState, useEffect, useCallback } from 'react';
import { HashRouter, Routes, Route, useLocation, useNavigate } from 'react-router-dom';
import { useApi } from './hooks/useApi';
import { fetchColonies } from './api/colonies';
import type { ColoniesResponse } from './api/colonies';
import { POLL_INTERVALS } from './utils/constants';
import { Sidebar } from './components/layout/Sidebar';
import { ErrorBoundary } from './components/ErrorBoundary';
import { KeyboardShortcutsModal } from './components/KeyboardShortcutsModal';
import { EmpireOverview } from './pages/EmpireOverview';
import { ColonyDetail } from './pages/ColonyDetail';
import { IntelMap } from './pages/IntelMap';
import { Advisor } from './pages/Advisor';
import { Recordings } from './pages/Recordings';
import { Debug } from './pages/Debug';

function AppContent() {
  const [sidebarOpen, setSidebarOpen] = useState(window.innerWidth >= 1024);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();

  const { data, loading, refetch } = useApi<ColoniesResponse>(
    fetchColonies,
    [],
    { pollInterval: POLL_INTERVALS.COLONIES }
  );

  const colonies = data?.colonies || [];

  // Close sidebar on navigation on mobile
  useEffect(() => {
    if (window.innerWidth < 1024) {
      setSidebarOpen(false);
    }
  }, [location]);

  // Handle resize
  useEffect(() => {
    const handler = () => {
      if (window.innerWidth >= 1024) {
        setSidebarOpen(true);
      }
    };
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Skip if user is typing in an input
      const el = document.activeElement;
      if (el) {
        const tag = el.tagName.toLowerCase();
        if (tag === 'input' || tag === 'textarea' || (el as HTMLElement).isContentEditable) {
          // Allow Escape to work
          if (e.key !== 'Escape') return;
        }
      }

      switch (e.key) {
        case '1':
          navigate('/');
          break;
        case '2':
          navigate('/intel');
          break;
        case '3':
          navigate('/advisor');
          break;
        case '4':
          navigate('/recordings');
          break;
        case '5':
          navigate('/debug');
          break;
        case '?':
          e.preventDefault();
          setShowShortcuts(true);
          break;
        case 'Escape':
          e.preventDefault();
          setShowShortcuts(false);
          setSidebarOpen(false);
          break;
        case 'r':
          if (!e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            refetch();
          }
          break;
        default:
          break;
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [navigate, refetch]);

  const handleCloseSidebar = useCallback(() => {
    setSidebarOpen(false);
  }, []);

  const handleToggleSidebar = useCallback(() => {
    setSidebarOpen((prev) => !prev);
  }, []);

  return (
    <div className="flex h-screen bg-[#111] text-[#eee] font-mono">
      <Sidebar
        colonies={colonies}
        loading={loading}
        open={sidebarOpen}
        onClose={handleCloseSidebar}
      />

      <main className="flex-1 overflow-hidden flex flex-col">
        {/* Mobile header with hamburger */}
        <div className="lg:hidden h-12 flex items-center px-4 border-b border-[#333] bg-[#1a1a1a]">
          <button
            type="button"
            onClick={handleToggleSidebar}
            className="text-[#888] hover:text-[#eee] p-1 mr-3"
            aria-label="Toggle sidebar"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <span className="text-[#00ff88] font-bold">Screeps Empire</span>
        </div>

        <div className="flex-1 overflow-hidden">
          <Routes>
            <Route path="/" element={
              <ErrorBoundary><EmpireOverview /></ErrorBoundary>
            } />
            <Route path="/colony/:roomName" element={
              <ErrorBoundary><ColonyDetail /></ErrorBoundary>
            } />
            <Route path="/intel" element={
              <ErrorBoundary><IntelMap /></ErrorBoundary>
            } />
            <Route path="/advisor" element={
              <ErrorBoundary><Advisor /></ErrorBoundary>
            } />
            <Route path="/recordings" element={
              <ErrorBoundary><Recordings /></ErrorBoundary>
            } />
            <Route path="/debug" element={
              <ErrorBoundary><Debug /></ErrorBoundary>
            } />
          </Routes>
        </div>
      </main>

      {/* Keyboard shortcuts modal */}
      <KeyboardShortcutsModal
        open={showShortcuts}
        onClose={() => setShowShortcuts(false)}
      />
    </div>
  );
}

function App() {
  return (
    <HashRouter>
      <AppContent />
    </HashRouter>
  );
}

export default App;
