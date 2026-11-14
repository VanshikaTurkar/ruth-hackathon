import React from 'react';
import { ArrowRight, HeartHandshake, Volume2 } from 'lucide-react';
import type { Settings } from '../shared/types';

interface LandingViewProps {
  settings: Settings;
  onNavigate: (path: '/' | '/senior' | '/caregiver') => void;
}

export const LandingView: React.FC<LandingViewProps> = ({ settings, onNavigate }) => {
  const handleLink = (e: React.MouseEvent<HTMLAnchorElement>, path: '/senior' | '/caregiver') => {
    e.preventDefault();
    onNavigate(path);
  };

  return (
    <div className="min-h-screen bg-stone-50 text-stone-900 flex flex-col">
      {/* Strict 3-Zone Top Bar Contract */}
      <header className="flex items-center justify-between gap-8 px-6 lg:px-12 py-4 border-b border-stone-200 bg-white">
        <a
          href="/"
          onClick={(e) => {
            e.preventDefault();
            onNavigate('/');
          }}
          className="text-xl font-bold tracking-tight text-stone-900 whitespace-nowrap shrink-0"
        >
          Huddle
        </a>

        <nav className="hidden md:flex items-center gap-6 text-sm font-semibold text-stone-600">
          <a
            href="/senior"
            onClick={(e) => handleLink(e, '/senior')}
            className="hover:text-stone-900 hover:underline underline-offset-4 transition-colors whitespace-nowrap shrink-0"
          >
            Senior Companion
          </a>
          <a
            href="/caregiver"
            onClick={(e) => handleLink(e, '/caregiver')}
            className="hover:text-stone-900 hover:underline underline-offset-4 transition-colors whitespace-nowrap shrink-0"
          >
            Family Dashboard
          </a>
        </nav>

        <div className="flex items-center shrink-0">
          <a
            href="/caregiver"
            onClick={(e) => handleLink(e, '/caregiver')}
            className="px-4 py-2 text-sm font-semibold text-white bg-teal-800 rounded-lg hover:bg-teal-900 transition-colors whitespace-nowrap shrink-0"
          >
            Open Dashboard
          </a>
        </div>
      </header>

      <main className="flex-1 flex items-center">
        <section className="max-w-4xl w-full mx-auto px-5 sm:px-6 lg:px-12 py-10 lg:py-16">
          <h1 className="text-3xl sm:text-4xl lg:text-5xl font-bold tracking-tight text-stone-950 leading-[1.12] mb-4 lg:mb-5 text-balance">
            Less checking up. More checking in.
          </h1>
          <p className="text-base sm:text-lg text-stone-700 leading-relaxed max-w-2xl mb-8 lg:mb-10 font-serif">
            Growing older at home shouldn&apos;t feel lonely, and family calls shouldn&apos;t
            sound like a checklist. Huddle quietly handles daily pill reminders in the background
            while sharing everyday voice notes, stories, and bright spots with loved ones,
            sparking warmer, more frequent conversations that keep everyone close.
          </p>

          {/* Primary Dual Entry Links */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
            <a
              href="/senior"
              onClick={(e) => handleLink(e, '/senior')}
              className="group flex flex-col justify-between p-6 rounded-2xl bg-teal-800 text-white hover:bg-teal-900 transition-colors min-h-[176px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-800"
            >
              <div>
                <div className="flex items-center justify-between gap-3 mb-3">
                  <span className="text-sm font-semibold text-teal-100">
                    Large print &amp; read-aloud
                  </span>
                  <Volume2 className="w-6 h-6 text-teal-100 shrink-0" aria-hidden="true" />
                </div>
                <h2 className="text-2xl font-bold tracking-tight">
                  I&apos;m {settings.seniorName} (Senior)
                </h2>
                <p className="text-sm text-teal-100 mt-1.5 leading-relaxed">
                  Next pill reminder, voice check-in, and family photo notes.
                </p>
              </div>
              <div className="mt-5 flex items-center gap-2 text-sm font-semibold text-white whitespace-nowrap">
                <span>Open {settings.seniorName}&apos;s view</span>
                <ArrowRight
                  className="w-4 h-4 transition-transform group-hover:translate-x-1"
                  aria-hidden="true"
                />
              </div>
            </a>

            <a
              href="/caregiver"
              onClick={(e) => handleLink(e, '/caregiver')}
              className="group flex flex-col justify-between p-6 rounded-2xl bg-white border border-stone-300 text-stone-900 hover:border-stone-900 transition-colors min-h-[176px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-900"
            >
              <div>
                <div className="flex items-center justify-between gap-3 mb-3">
                  <span className="text-sm font-semibold text-stone-500">
                    Family dashboard
                  </span>
                  <HeartHandshake className="w-6 h-6 text-teal-800 shrink-0" aria-hidden="true" />
                </div>
                <h2 className="text-2xl font-bold tracking-tight">
                  I&apos;m {settings.caregiverName} (Family)
                </h2>
                <p className="text-sm text-stone-600 mt-1.5 leading-relaxed">
                  Scan bottles, review check-in summaries, and get warm call openers.
                </p>
              </div>
              <div className="mt-5 flex items-center gap-2 text-sm font-semibold text-teal-800 whitespace-nowrap">
                <span>Open {settings.caregiverName}&apos;s dashboard</span>
                <ArrowRight
                  className="w-4 h-4 transition-transform group-hover:translate-x-1"
                  aria-hidden="true"
                />
              </div>
            </a>
          </div>
        </section>
      </main>
    </div>
  );
};
