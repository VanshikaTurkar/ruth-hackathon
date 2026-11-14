import { useCallback, useEffect, useState } from 'react';
import type { AppState } from './shared/types';
import { LandingView } from './components/LandingView';
import { SeniorView } from './components/SeniorView';
import { CaregiverView } from './components/CaregiverView';
import { OfflineIndicator } from './components/MobileAppChrome';

type RoutePath = '/' | '/senior' | '/caregiver';

const CACHED_STATE_KEY = 'huddle_cached_state_v1';
const LEGACY_CACHED_STATE_KEY = 'carecircle_cached_state_v1';

function loadCachedState(): AppState | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw =
      window.localStorage.getItem(CACHED_STATE_KEY) ||
      window.localStorage.getItem(LEGACY_CACHED_STATE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AppState;
    if (parsed && parsed.settings && Array.isArray(parsed.medications)) {
      return parsed;
    }
  } catch {
    // Ignore storage errors
  }
  return null;
}

function saveCachedState(nextState: AppState): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(CACHED_STATE_KEY, JSON.stringify(nextState));
  } catch {
    // Ignore quota errors
  }
}

function resolveRouteFromWindow(): RoutePath {
  if (typeof window === 'undefined') return '/';
  const params = new URLSearchParams(window.location.search);
  const autostart = params.get('autostart');
  const pathname = window.location.pathname.replace(/\/+$/, '') || '/';

  if (pathname === '/senior') return '/senior';
  if (pathname === '/caregiver') return '/caregiver';
  if (autostart === '1') return '/caregiver';
  return '/';
}

export default function App() {
  const [route, setRoute] = useState<RoutePath>(() => resolveRouteFromWindow());
  const [appState, setAppState] = useState<AppState | null>(() => loadCachedState());
  const [loadError, setLoadError] = useState<string | null>(null);

  const viewParam = route === '/caregiver' ? 'caregiver' : 'senior';

  const fetchState = useCallback(async () => {
    try {
      const tzOffset = new Date().getTimezoneOffset();
      const response = await fetch(`/api/state?view=${viewParam}&tzOffset=${tzOffset}`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const data = (await response.json()) as AppState;
      setAppState(data);
      saveCachedState(data);
      setLoadError(null);
    } catch {
      setLoadError('Reconnecting to Huddle…');
    }
  }, [viewParam]);

  // Initial fetch + 3-second polling as specified
  useEffect(() => {
    void fetchState();
    const timer = setInterval(() => {
      void fetchState();
    }, 3_000);
    return () => clearInterval(timer);
  }, [fetchState]);

  useEffect(() => {
    const onPopState = () => {
      setRoute(resolveRouteFromWindow());
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const navigate = useCallback((nextPath: RoutePath) => {
    if (window.location.pathname !== nextPath) {
      window.history.pushState({}, '', nextPath);
    }
    window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
    setRoute(nextPath);
  }, []);

  if (!appState) {
    return (
      <div className="min-h-screen bg-stone-50 flex flex-col">
        <OfflineIndicator />
        <div className="flex-1 flex items-center justify-center p-6">
          <div className="max-w-md w-full p-8 rounded-2xl border border-stone-200 bg-white text-center space-y-3">
            <div className="w-8 h-8 rounded-full border-2 border-teal-800 border-t-transparent animate-spin mx-auto" />
            <p className="text-base font-semibold text-stone-900">
              {loadError || 'Loading Huddle…'}
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <OfflineIndicator />
      {route === '/senior' ? (
        <SeniorView state={appState} onRefresh={fetchState} onNavigate={navigate} />
      ) : route === '/caregiver' ? (
        <CaregiverView state={appState} onRefresh={fetchState} onNavigate={navigate} />
      ) : (
        <LandingView settings={appState.settings} onNavigate={navigate} />
      )}
    </>
  );
}
