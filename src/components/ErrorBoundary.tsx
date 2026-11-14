import React from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  render() {
    const { error } = this.state;
    if (!error) {
      return this.props.children;
    }

    const friendlyDetail = error.message || String(error);

    return (
      <div className="min-h-screen bg-stone-50 flex items-center justify-center p-6">
        <div className="max-w-lg w-full p-7 rounded-2xl border border-stone-300 bg-white space-y-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-6 h-6 text-amber-700 shrink-0 mt-0.5" aria-hidden="true" />
            <div className="space-y-1">
              <h1 className="text-xl font-bold text-stone-950">Something went wrong</h1>
              <p className="text-sm text-stone-700 leading-relaxed">{friendlyDetail}</p>
            </div>
          </div>

          <div className="pt-2">
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-teal-800 text-white text-sm font-semibold hover:bg-teal-900 cursor-pointer"
            >
              <RefreshCw className="w-4 h-4" aria-hidden="true" />
              <span>Reload Huddle</span>
            </button>
          </div>
        </div>
      </div>
    );
  }
}
