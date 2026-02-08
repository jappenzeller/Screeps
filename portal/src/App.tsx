import { HashRouter, Routes, Route } from 'react-router-dom';
import { useApi } from './hooks/useApi';
import { fetchColonies } from './api/colonies';
import type { ColoniesResponse } from './api/colonies';
import { POLL_INTERVALS } from './utils/constants';
import { Sidebar } from './components/layout/Sidebar';
import { EmpireOverview } from './pages/EmpireOverview';
import { ColonyDetail } from './pages/ColonyDetail';
import { IntelMap } from './pages/IntelMap';
import { Advisor } from './pages/Advisor';
import { Recordings } from './pages/Recordings';
import { Debug } from './pages/Debug';

function App() {
  const { data, loading } = useApi<ColoniesResponse>(
    fetchColonies,
    [],
    { pollInterval: POLL_INTERVALS.COLONIES }
  );

  const colonies = data?.colonies || [];

  return (
    <HashRouter>
      <div className="flex h-screen bg-[#111] text-[#eee] font-mono">
        <Sidebar colonies={colonies} loading={loading} />
        <main className="flex-1 overflow-hidden">
          <Routes>
            <Route path="/" element={<EmpireOverview />} />
            <Route path="/colony/:roomName" element={<ColonyDetail />} />
            <Route path="/intel" element={<IntelMap />} />
            <Route path="/advisor" element={<Advisor />} />
            <Route path="/recordings" element={<Recordings />} />
            <Route path="/debug" element={<Debug />} />
          </Routes>
        </main>
      </div>
    </HashRouter>
  );
}

export default App;
