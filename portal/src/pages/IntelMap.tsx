import { Header } from '../components/layout/Header';

export function IntelMap() {
  return (
    <div className="flex flex-col h-full">
      <Header title="Intel Map" />
      <div className="flex-1 flex items-center justify-center bg-[#111]">
        <div className="text-center">
          <h2 className="text-2xl font-bold text-[#eee] mb-2">Intel Map</h2>
          <p className="text-[#888]">Coming in Phase 3</p>
        </div>
      </div>
    </div>
  );
}
