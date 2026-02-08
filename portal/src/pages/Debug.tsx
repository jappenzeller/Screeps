import { Header } from '../components/layout/Header';
import { CommandConsole } from '../components/debug/CommandConsole';
import { PositionViewer } from '../components/debug/PositionViewer';

export function Debug() {
  return (
    <div className="flex flex-col h-full">
      <Header title="Debug Console" />

      <div className="flex-1 flex flex-col lg:flex-row overflow-hidden bg-[#111]">
        {/* Command Console (60% on large screens) */}
        <div className="flex-1 lg:w-[60%] p-4 overflow-hidden flex flex-col min-h-[400px] lg:min-h-0">
          <h3 className="text-sm font-medium text-[#888] uppercase tracking-wider mb-3 flex-shrink-0">
            Command Console
          </h3>
          <div className="flex-1 overflow-hidden">
            <CommandConsole />
          </div>
        </div>

        {/* Position Viewer (40% on large screens) */}
        <div className="lg:w-[40%] border-t lg:border-t-0 lg:border-l border-[#333] p-4 overflow-y-auto">
          <h3 className="text-sm font-medium text-[#888] uppercase tracking-wider mb-3">
            Position Viewer
          </h3>
          <PositionViewer />
        </div>
      </div>
    </div>
  );
}
