import { Header } from '../components/layout/Header';

export function Advisor() {
  return (
    <div className="flex flex-col h-full">
      <Header title="AI Advisor" />
      <div className="flex-1 flex items-center justify-center bg-[#111]">
        <div className="text-center">
          <h2 className="text-2xl font-bold text-[#eee] mb-2">AI Advisor</h2>
          <p className="text-[#888]">Coming in Phase 4</p>
        </div>
      </div>
    </div>
  );
}
