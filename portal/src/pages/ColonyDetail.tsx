import { useParams } from 'react-router-dom';
import { Header } from '../components/layout/Header';

export function ColonyDetail() {
  const { roomName } = useParams<{ roomName: string }>();

  return (
    <div className="flex flex-col h-full">
      <Header title={`Colony: ${roomName}`} />
      <div className="flex-1 flex items-center justify-center bg-[#111]">
        <div className="text-center">
          <h2 className="text-2xl font-bold text-[#eee] mb-2">{roomName}</h2>
          <p className="text-[#888]">Colony Detail — Coming in Phase 2</p>
        </div>
      </div>
    </div>
  );
}
