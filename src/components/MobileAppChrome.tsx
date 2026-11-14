import React from 'react';
import { WifiOff } from 'lucide-react';
import { useOnlineStatus } from '../hooks/usePWA';

export const OfflineIndicator: React.FC = () => {
  const isOnline = useOnlineStatus();

  if (isOnline) {
    return null;
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="bg-amber-900 text-white px-4 py-2 text-xs font-semibold flex items-center justify-center gap-2 text-center"
    >
      <WifiOff className="w-4 h-4 shrink-0" aria-hidden="true" />
      <span>Offline mode — showing saved schedule on this phone until connection returns.</span>
    </div>
  );
};
