'use client';

import { useState } from 'react';
import { TrainFront } from 'lucide-react';
import { GermanyStationMap, SelectedStationMap, type Station } from './germany-station-map';

export default function Home() {
  const [selectedStation, setSelectedStation] = useState<Station | null>(null);

  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border bg-[#071b2b] text-white">
        <div className="mx-auto flex max-w-[1440px] items-center gap-3 px-5 py-4 lg:px-10">
          <span className="grid h-10 w-10 place-items-center rounded-md bg-[#f5a623] text-[#071b2b]"><TrainFront size={22}/></span>
          <div>
            <p className="text-sm font-semibold tracking-wide">DB INFRASTRUKTURDATEN</p>
            <p className="text-xs text-slate-300">{selectedStation ? 'Einheitliche Stationsprüfung' : 'Deutschlandweite Bahnhofsauswahl'}</p>
          </div>
        </div>
      </header>
      <div className="mx-auto max-w-[1440px] px-5 py-7 lg:px-10 lg:py-10">
        {selectedStation
          ? <SelectedStationMap key={selectedStation.id} station={selectedStation} onBack={() => setSelectedStation(null)}/>
          : <GermanyStationMap onSelect={setSelectedStation}/>
        }
      </div>
    </main>
  );
}
