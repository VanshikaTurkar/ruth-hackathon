import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertOctagon,
  Check,
  Heart,
  Loader2,
  Mic,
  MicOff,
  PhoneCall,
  Settings,
  ShieldAlert,
  Volume2,
} from 'lucide-react';
import type { AppState, CheckIn, DoseEvent, FamilyMessage, Medication } from '../shared/types';
import {
  isDoseInReminderWindow,
  REMINDER_LEAD_MINUTES,
  shouldShowPillImageForSenior,
} from '../shared/careLogic';
import {
  formatClockTime,
  getGreetingForTime,
  preloadSpeechAudio,
  readApiJson,
  resolveMedicationPillImage,
  speakAloud,
  triggerGentleVibration,
} from '../utils/clientHelpers';

interface SeniorViewProps {
  state: AppState;
  onRefresh: () => Promise<void>;
  onNavigate: (path: '/' | '/senior' | '/caregiver') => void;
}

interface SpeechRecognitionAlternativeLike {
  transcript: string;
}

interface SpeechRecognitionResultLike {
  isFinal: boolean;
  0: SpeechRecognitionAlternativeLike;
}

interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResultLike>;
}

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
}

function getSpeechRecognitionConstructor(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === 'undefined') return null;
  const win = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return win.SpeechRecognition || win.webkitSpeechRecognition || null;
}

export const SeniorView: React.FC<SeniorViewProps> = ({ state, onRefresh, onNavigate }) => {
  const [clockNow, setClockNow] = useState<Date>(() => new Date());
  const [takingDoseId, setTakingDoseId] = useState<string | null>(null);

  // Check-in state
  const [checkinOpen, setCheckinOpen] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [listening, setListening] = useState(false);
  const [sendingCheckin, setSendingCheckin] = useState(false);
  const [checkinError, setCheckinError] = useState<string | null>(null);
  const [replyFromAi, setReplyFromAi] = useState<string | null>(null);
  const [urgentEmergencyActive, setUrgentEmergencyActive] = useState(false);

  // Help flow state
  const [helpConfirmOpen, setHelpConfirmOpen] = useState(false);
  const [helpSentBanner, setHelpSentBanner] = useState(false);
  const [sendingHelp, setSendingHelp] = useState(false);

  // Privacy modal/disclosure state
  const [privacyOpen, setPrivacyOpen] = useState(false);
  const [savingPrivacy, setSavingPrivacy] = useState(false);

  // Message and pill image fallback tracking
  const [failedPhotoIds, setFailedPhotoIds] = useState<Record<string, boolean>>({});
  const [failedPillImgIds, setFailedPillImgIds] = useState<Record<string, boolean>>({});

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const spokenReminderKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const interval = setInterval(() => setClockNow(new Date()), 15_000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    return () => {
      recognitionRef.current?.stop();
    };
  }, []);

  const medById = useMemo(() => {
    const map = new Map<string, Medication>();
    for (const m of state.medications) {
      map.set(m.id, m);
    }
    return map;
  }, [state.medications]);

  const sortedDoses = useMemo(() => {
    return [...state.doses].sort(
      (a, b) => new Date(a.scheduledFor).getTime() - new Date(b.scheduledFor).getTime()
    );
  }, [state.doses]);

  const leadMinutes = state.settings.reminderLeadMinutes ?? REMINDER_LEAD_MINUTES;

  const dueDose: DoseEvent | null = useMemo(() => {
    return (
      sortedDoses.find((d) =>
        isDoseInReminderWindow(d, clockNow, state.settings.doseGraceMinutes, leadMinutes)
      ) || null
    );
  }, [sortedDoses, clockNow, state.settings.doseGraceMinutes, leadMinutes]);

  const dueMedication = dueDose ? medById.get(dueDose.medicationId) || null : null;

  const isDueRightNow = Boolean(
    dueDose &&
      (dueDose.remindedAt !== null ||
        clockNow.getTime() >= new Date(dueDose.scheduledFor).getTime())
  );

  const nextFuturePendingDose: DoseEvent | null = useMemo(() => {
    return (
      sortedDoses.find(
        (d) =>
          d.status === 'pending' &&
          d.id !== dueDose?.id &&
          new Date(d.scheduledFor).getTime() > clockNow.getTime()
      ) || null
    );
  }, [sortedDoses, dueDose?.id, clockNow]);

  const nextFutureMedication = nextFuturePendingDose
    ? medById.get(nextFuturePendingDose.medicationId) || null
    : null;

  const unplayedMessages = useMemo(
    () => state.messages.filter((m) => m.playedAt === null),
    [state.messages]
  );

  // Read reminder aloud once & vibrate when a dose becomes due
  useEffect(() => {
    if (!dueDose || !dueMedication || !isDueRightNow) return;
    const key = `${dueDose.id}_${dueDose.remindedAt || dueDose.scheduledFor}`;
    if (spokenReminderKeyRef.current === key) return;
    spokenReminderKeyRef.current = key;

    const spokenText = `Time for your pill, ${state.settings.seniorName}. ${dueMedication.name}, ${dueMedication.dose}${
      dueMedication.purpose ? `, ${dueMedication.purpose}` : ''
    }.`;
    speakAloud(spokenText);
    triggerGentleVibration();
  }, [dueDose, dueMedication, isDueRightNow, state.settings.seniorName]);

  const handleMarkTaken = async (doseId: string) => {
    setTakingDoseId(doseId);
    try {
      await fetch(`/api/doses/${doseId}/taken`, { method: 'POST' });
      await onRefresh();
    } finally {
      setTakingDoseId(null);
    }
  };

  const startSpeechListening = () => {
    const SpeechConstructor = getSpeechRecognitionConstructor();
    if (!SpeechConstructor) return;

    try {
      recognitionRef.current?.stop();
      const rec = new SpeechConstructor();
      rec.continuous = true;
      rec.interimResults = true;
      rec.lang = 'en-US';

      rec.onresult = (event) => {
        let built = '';
        for (let i = 0; i < event.results.length; i++) {
          built += event.results[i][0].transcript + ' ';
        }
        setTranscript(built.trim());
      };
      rec.onerror = () => setListening(false);
      rec.onend = () => setListening(false);

      recognitionRef.current = rec;
      rec.start();
      setListening(true);
    } catch {
      setListening(false);
    }
  };

  const stopSpeechListening = () => {
    recognitionRef.current?.stop();
    setListening(false);
  };

  const handleOpenCheckin = () => {
    setCheckinOpen(true);
    setCheckinError(null);
    setReplyFromAi(null);
    const promptQuestion = `How are you feeling today, ${state.settings.seniorName}?`;
    speakAloud(promptQuestion, () => {
      startSpeechListening();
    });
  };

  const handleSubmitCheckin = async (e: React.FormEvent) => {
    e.preventDefault();
    stopSpeechListening();
    if (!transcript.trim()) {
      setCheckinError('Please say or type a few words about how you are feeling first.');
      return;
    }

    setSendingCheckin(true);
    setCheckinError(null);
    try {
      const res = await fetch('/api/checkins', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transcript: transcript.trim(),
          keptPrivate: !state.settings.shareCheckinWords,
        }),
      });
      const payload = await readApiJson<{
        checkin?: CheckIn;
        replyToSenior?: string;
        error?: string;
      }>(
        res,
        "We couldn't reach Huddle right now. Please try sending your check-in once more."
      );
      if (!res.ok || !payload.checkin) {
        throw new Error(payload.error || 'Could not send check-in right now.');
      }

      const replyText =
        payload.replyToSenior || `Thank you for checking in, ${state.settings.seniorName}.`;
      setReplyFromAi(replyText);
      setTranscript('');
      speakAloud(replyText);

      if (payload.checkin.urgent) {
        setUrgentEmergencyActive(true);
        void fetch('/api/help', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ source: 'urgent_checkin' }),
        });
      }

      await onRefresh();
    } catch (err) {
      setCheckinError(
        err instanceof Error ? err.message : 'Could not send check-in. Please try again.'
      );
    } finally {
      setSendingCheckin(false);
    }
  };

  const handleConfirmHelp = async () => {
    setSendingHelp(true);
    try {
      await fetch('/api/help', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 'help_button' }),
      });
      setHelpConfirmOpen(false);
      setHelpSentBanner(true);
      speakAloud(
        `${state.settings.caregiverName} has been alerted. If this is an emergency, please call 911.`
      );
      await onRefresh();
    } finally {
      setSendingHelp(false);
    }
  };

  const handlePlayFamilyMessage = async (msg: FamilyMessage) => {
    const toSpeak = msg.text
      ? `A message from ${msg.from}. ${msg.text}`
      : `A photo message from ${msg.from}.`;
    speakAloud(toSpeak);
    await fetch(`/api/messages/${msg.id}/played`, { method: 'POST' });
    await onRefresh();
  };

  const handleToggleShareSetting = async (nextShareValue: boolean) => {
    setSavingPrivacy(true);
    try {
      await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shareCheckinWords: nextShareValue }),
      });
      await onRefresh();
    } finally {
      setSavingPrivacy(false);
    }
  };

  const speechSupported = Boolean(getSpeechRecognitionConstructor());
  const dueCardSummaryText =
    dueDose && dueMedication
      ? `${isDueRightNow ? 'Time for your pill. ' : 'Coming up soon: '}${dueMedication.name}, ${
          dueMedication.dose
        }, scheduled for ${formatClockTime(dueDose.scheduledFor)}${
          dueMedication.purpose ? `, ${dueMedication.purpose}` : ''
        }${dueMedication.withFood ? '. Take with food.' : ''}`
      : nextFuturePendingDose && nextFutureMedication
        ? `No pills due right now, ${state.settings.seniorName}. Your next pill is ${
            nextFutureMedication.name
          } at ${formatClockTime(nextFuturePendingDose.scheduledFor)}.`
        : `You have no pills due right now, ${state.settings.seniorName}.`;

  // Pre-warm natural neural voice clips so taps play immediately without delay
  useEffect(() => {
    preloadSpeechAudio(`How are you feeling today, ${state.settings.seniorName}?`);
    if (dueDose && dueMedication) {
      preloadSpeechAudio(dueCardSummaryText);
    }
    for (const msg of unplayedMessages.slice(0, 2)) {
      const toSpeak = msg.text
        ? `A message from ${msg.from}. ${msg.text}`
        : `A photo message from ${msg.from}.`;
      preloadSpeechAudio(toSpeak);
    }
  }, [
    state.settings.seniorName,
    dueDose?.id,
    dueMedication?.id,
    dueCardSummaryText,
    unplayedMessages,
  ]);

  return (
    <div className="min-h-screen bg-stone-50 text-stone-950 text-[24px] leading-snug pb-36 pt-safe">
      <main className="max-w-5xl mx-auto px-4 sm:px-6 pt-6 pb-8 space-y-6">
        {/* Top Greeting + Date/Time + Top-Right Settings Icon */}
        <header className="pb-5 border-b border-stone-300 space-y-2">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-3 text-base font-semibold text-stone-600 mb-2">
                <a
                  href="/"
                  onClick={(e) => {
                    e.preventDefault();
                    onNavigate('/');
                  }}
                  className="underline underline-offset-4 hover:text-stone-950 whitespace-nowrap"
                >
                  Huddle Home
                </a>
              </div>
              <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-stone-950">
                {getGreetingForTime(clockNow)}, {state.settings.seniorName}
              </h1>
            </div>

            <button
              type="button"
              onClick={() => setPrivacyOpen((prev) => !prev)}
              aria-label="Settings and privacy"
              aria-expanded={privacyOpen}
              title="Settings & privacy"
              className={`shrink-0 min-h-[56px] min-w-[56px] rounded-2xl border-2 flex items-center justify-center transition-colors cursor-pointer ${
                privacyOpen
                  ? 'border-teal-800 bg-teal-50 text-teal-950'
                  : 'border-stone-300 bg-white text-stone-800 hover:bg-stone-100 hover:text-stone-950'
              }`}
            >
              <Settings className="w-7 h-7" aria-hidden="true" />
            </button>
          </div>

          <p className="text-[22px] sm:text-[24px] text-stone-700 tabular-nums">
            {clockNow.toLocaleDateString('en-US', {
              weekday: 'long',
              month: 'long',
              day: 'numeric',
            })}{' '}
            ·{' '}
            {clockNow.toLocaleTimeString('en-US', {
              hour: 'numeric',
              minute: '2-digit',
            })}
          </p>
        </header>

        {/* Settings & Privacy Drawer */}
        {privacyOpen && (
          <section
            aria-label="Settings and privacy"
            className="p-6 rounded-2xl border-2 border-stone-800 bg-white space-y-4"
          >
            <div className="flex items-start justify-between gap-4">
              <h2 className="text-[26px] font-bold text-stone-950">Settings &amp; My privacy</h2>
              <button
                type="button"
                onClick={() => setPrivacyOpen(false)}
                className="px-4 min-h-[48px] rounded-xl border border-stone-300 text-lg font-semibold text-stone-800 hover:bg-stone-100 cursor-pointer"
              >
                Close
              </button>
            </div>

            <label className="flex items-center justify-between gap-4 p-4 rounded-xl bg-stone-100 min-h-[68px] cursor-pointer">
              <span className="text-[22px] sm:text-[24px] font-semibold text-stone-950">
                Share my check-in words with family
              </span>
              <input
                type="checkbox"
                disabled={savingPrivacy}
                checked={state.settings.shareCheckinWords}
                onChange={(e) => void handleToggleShareSetting(e.target.checked)}
                className="w-8 h-8 accent-teal-800 shrink-0 cursor-pointer"
              />
            </label>

            <p className="text-[20px] sm:text-[22px] text-stone-800 leading-relaxed">
              Urgent safety concerns are always shared so your family can help.
            </p>
          </section>
        )}

        {/* Urgent Check-In Emergency Panel */}
        {urgentEmergencyActive && (
          <section
            role="alert"
            className="p-6 rounded-2xl border-2 border-red-700 bg-red-50 text-red-950 space-y-4"
          >
            <div className="flex items-start gap-3">
              <AlertOctagon className="w-9 h-9 text-red-700 shrink-0 mt-1" aria-hidden="true" />
              <div className="space-y-1">
                <h2 className="text-[28px] font-bold text-red-950">
                  Please call 911 if this is an emergency
                </h2>
                <p className="text-[24px] font-semibold text-red-900">
                  I&apos;ve told {state.settings.caregiverName}.
                </p>
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <a
                href="tel:911"
                className="w-full min-h-[68px] px-6 rounded-2xl bg-red-700 text-white font-bold text-[26px] flex items-center justify-center gap-3 hover:bg-red-800 transition-colors"
              >
                <PhoneCall className="w-7 h-7 shrink-0" aria-hidden="true" />
                <span>Call 911 now</span>
              </a>
              <button
                type="button"
                onClick={() => setUrgentEmergencyActive(false)}
                className="w-full min-h-[68px] px-6 rounded-2xl border-2 border-red-300 bg-white text-red-950 font-semibold text-[22px] hover:bg-red-100 transition-colors cursor-pointer"
              >
                Dismiss banner
              </button>
            </div>
          </section>
        )}

        {/* Help Button Confirmation Banner */}
        {helpSentBanner && (
          <section
            role="status"
            className="p-6 rounded-2xl border-2 border-red-700 bg-red-50 text-red-950 space-y-4"
          >
            <p className="text-[26px] font-bold">
              {state.settings.caregiverName} has been alerted. If this is an emergency, call 911.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <a
                href="tel:911"
                className="w-full min-h-[68px] px-6 rounded-2xl bg-red-700 text-white font-bold text-[26px] flex items-center justify-center gap-3 hover:bg-red-800 transition-colors"
              >
                <PhoneCall className="w-7 h-7 shrink-0" aria-hidden="true" />
                <span>Call 911</span>
              </a>
              <button
                type="button"
                onClick={() => setHelpSentBanner(false)}
                className="w-full min-h-[68px] px-6 rounded-2xl border-2 border-stone-400 bg-white text-stone-900 font-semibold text-[22px] hover:bg-stone-100 transition-colors cursor-pointer"
              >
                Okay
              </button>
            </div>
          </section>
        )}

        {/* Unplayed Family Messages */}
        {unplayedMessages.map((msg) => (
          <section
            key={msg.id}
            aria-label={`Message from ${msg.from}`}
            className="p-6 rounded-2xl border-2 border-teal-700 bg-white space-y-4"
          >
            <div className="flex items-center gap-3 text-teal-900">
              <Heart className="w-7 h-7 shrink-0" aria-hidden="true" />
              <h2 className="text-[26px] font-bold">A message from {msg.from}</h2>
            </div>

            {msg.photoDataUrl && !failedPhotoIds[msg.id] && (
              <div className="rounded-xl overflow-hidden border border-stone-200 bg-stone-100">
                <img
                  src={msg.photoDataUrl}
                  alt={`Photo sent by ${msg.from}`}
                  referrerPolicy="no-referrer"
                  onError={() =>
                    setFailedPhotoIds((prev) => ({
                      ...prev,
                      [msg.id]: true,
                    }))
                  }
                  className="w-full max-h-[340px] object-cover"
                />
              </div>
            )}

            {msg.text && (
              <p className="text-[26px] font-serif text-stone-950 leading-relaxed">
                &ldquo;{msg.text}&rdquo;
              </p>
            )}

            <button
              type="button"
              onClick={() => void handlePlayFamilyMessage(msg)}
              className="w-full min-h-[68px] px-6 rounded-2xl bg-teal-800 text-white font-bold text-[24px] flex items-center justify-center gap-3 hover:bg-teal-900 transition-colors cursor-pointer"
            >
              <Volume2 className="w-7 h-7 shrink-0" aria-hidden="true" />
              <span>Read aloud</span>
            </button>
          </section>
        ))}

        {/* Responsive 2-column grid on Desktop, stacked 1-column on Phone */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          <div className="lg:col-span-7 space-y-6">
            {/* Time-Gated Medication Reminder Card (only shown when due now or right before) */}
            {dueDose && dueMedication ? (
              <section
                aria-label="Medication reminder"
                className={`p-6 rounded-2xl space-y-5 ${
                  isDueRightNow
                    ? 'border-2 border-amber-500 bg-amber-50'
                    : 'border-2 border-teal-700 bg-white'
                }`}
              >
                <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
                  <div className="space-y-1 flex-1 min-w-0">
                    {isDueRightNow ? (
                      <p className="text-[22px] font-bold text-amber-900">Time for your pill</p>
                    ) : (
                      <p className="text-[22px] font-bold text-teal-900">
                        Coming up soon · {formatClockTime(dueDose.scheduledFor)}
                      </p>
                    )}
                    <h2 className="text-[28px] sm:text-[32px] font-bold text-stone-950 leading-tight">
                      {dueMedication.name}, {dueMedication.dose},{' '}
                      <span className="tabular-nums">
                        {formatClockTime(dueDose.scheduledFor)}
                      </span>
                      {dueMedication.purpose ? `, ${dueMedication.purpose}` : ''}
                    </h2>
                    <p className="text-[22px] text-stone-700 pt-1">
                      {dueMedication.strength}
                      {dueMedication.instructions ? ` · ${dueMedication.instructions}` : ''}
                      {dueMedication.withFood ? ' · Take with food' : ''}
                    </p>
                  </div>

                  {(() => {
                    const duePillImg = resolveMedicationPillImage(dueMedication);
                    if (!duePillImg || failedPillImgIds[dueMedication.id]) return null;
                    return (
                      <div className="shrink-0 flex flex-col items-start sm:items-center gap-1.5">
                        <img
                          src={duePillImg}
                          alt={`${dueMedication.name} ${dueMedication.strength} pill`}
                          referrerPolicy="no-referrer"
                          onError={() =>
                            setFailedPillImgIds((prev) => ({ ...prev, [dueMedication.id]: true }))
                          }
                          className="w-28 h-28 sm:w-32 sm:h-32 rounded-2xl object-cover border-2 border-stone-300 bg-white"
                        />
                        <span className="text-base font-semibold text-stone-600">
                          What this pill looks like
                        </span>
                      </div>
                    );
                  })()}
                </div>

                <div className="space-y-3 pt-1">
                  <button
                    type="button"
                    disabled={takingDoseId === dueDose.id}
                    onClick={() => void handleMarkTaken(dueDose.id)}
                    className="w-full min-h-[76px] px-6 rounded-2xl bg-teal-800 text-white font-bold text-[28px] flex items-center justify-center gap-3 hover:bg-teal-900 active:scale-[0.99] disabled:opacity-60 transition-all cursor-pointer"
                  >
                    {takingDoseId === dueDose.id ? (
                      <Loader2 className="w-8 h-8 animate-spin shrink-0" aria-hidden="true" />
                    ) : (
                      <Check className="w-8 h-8 shrink-0 stroke-[3]" aria-hidden="true" />
                    )}
                    <span>I took it</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => speakAloud(dueCardSummaryText)}
                    className="w-full min-h-[64px] px-5 rounded-2xl border-2 border-stone-300 bg-stone-50 text-stone-900 font-semibold text-[22px] flex items-center justify-center gap-2.5 hover:bg-stone-100 transition-colors cursor-pointer"
                  >
                    <Volume2 className="w-6 h-6 shrink-0" aria-hidden="true" />
                    <span>Read pill aloud</span>
                  </button>
                </div>
              </section>
            ) : (
              <section
                aria-label="Medication status"
                className="p-5 sm:p-6 rounded-2xl border border-stone-300 bg-white space-y-2"
              >
                <p className="text-[24px] font-bold text-stone-950">No pills due right now</p>
                {nextFuturePendingDose && nextFutureMedication ? (
                  <p className="text-[20px] sm:text-[22px] text-stone-700 tabular-nums">
                    Next reminder around {formatClockTime(nextFuturePendingDose.scheduledFor)} ·{' '}
                    {nextFutureMedication.name} ({nextFutureMedication.dose})
                  </p>
                ) : (
                  <p className="text-[20px] sm:text-[22px] text-stone-700">
                    We will remind you here when it is time for your next scheduled pill.
                  </p>
                )}
              </section>
            )}

            {/* Daily Spoken Check-in Card */}
            <section
              aria-label="Daily check-in"
              className="p-6 rounded-2xl border border-stone-300 bg-white space-y-5"
            >
              <div className="space-y-1">
                <h2 className="text-[28px] font-bold text-stone-950">Daily check-in</h2>
                <p className="text-[22px] text-stone-700">
                  Share how your day is going in your own words.
                </p>
              </div>

              {!checkinOpen ? (
                <button
                  type="button"
                  onClick={handleOpenCheckin}
                  className="w-full min-h-[76px] px-6 rounded-2xl bg-stone-900 text-white font-bold text-[24px] sm:text-[26px] flex items-center justify-center gap-3 hover:bg-stone-800 transition-colors cursor-pointer"
                >
                  <Mic className="w-7 h-7 shrink-0" aria-hidden="true" />
                  <span>How are you feeling today?</span>
                </button>
              ) : (
                <form onSubmit={handleSubmitCheckin} className="space-y-4">
                  {speechSupported && (
                    <div className="flex flex-wrap items-center gap-3">
                      <button
                        type="button"
                        onClick={listening ? stopSpeechListening : startSpeechListening}
                        className={`flex-1 min-h-[64px] px-5 rounded-2xl font-bold text-[22px] flex items-center justify-center gap-2.5 transition-colors cursor-pointer ${
                          listening
                            ? 'bg-red-700 text-white hover:bg-red-800'
                            : 'bg-stone-200 text-stone-950 hover:bg-stone-300'
                        }`}
                      >
                        {listening ? (
                          <>
                            <MicOff className="w-6 h-6 shrink-0" aria-hidden="true" />
                            <span>Stop listening</span>
                          </>
                        ) : (
                          <>
                            <Mic className="w-6 h-6 shrink-0" aria-hidden="true" />
                            <span>Speak with microphone</span>
                          </>
                        )}
                      </button>
                    </div>
                  )}

                  <div>
                    {listening && (
                      <p className="text-[20px] font-bold text-red-800 mb-1">
                        Microphone is listening — speak naturally or type below.
                      </p>
                    )}
                    <label
                      htmlFor="senior-checkin-input"
                      className="block text-[22px] font-semibold text-stone-900 mb-2"
                    >
                      Say or type how you are feeling today:
                    </label>
                    <textarea
                      id="senior-checkin-input"
                      rows={4}
                      value={transcript}
                      onChange={(e) => setTranscript(e.target.value)}
                      placeholder="For example: I felt a little dizzy this morning, and Maya came over to bake cookies..."
                      className="w-full p-4 rounded-2xl border-2 border-stone-400 bg-stone-50 text-[24px] text-stone-950 leading-relaxed focus:outline-none focus:border-teal-800"
                    />
                  </div>

                  {checkinError && (
                    <div
                      role="alert"
                      className="p-4 rounded-xl border border-red-400 bg-red-50 text-[20px] text-red-950 font-semibold"
                    >
                      {checkinError}
                    </div>
                  )}

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <button
                      type="submit"
                      disabled={sendingCheckin}
                      className="w-full min-h-[68px] px-6 rounded-2xl bg-teal-800 text-white font-bold text-[26px] flex items-center justify-center gap-3 hover:bg-teal-900 disabled:opacity-60 transition-colors cursor-pointer"
                    >
                      {sendingCheckin && (
                        <Loader2 className="w-7 h-7 animate-spin shrink-0" aria-hidden="true" />
                      )}
                      <span>{sendingCheckin ? 'Sending…' : 'Send'}</span>
                    </button>
                    <button
                      type="button"
                      disabled={sendingCheckin}
                      onClick={() => {
                        stopSpeechListening();
                        setCheckinOpen(false);
                      }}
                      className="w-full min-h-[68px] px-6 rounded-2xl border-2 border-stone-300 bg-white text-stone-800 font-semibold text-[22px] hover:bg-stone-100 transition-colors cursor-pointer"
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              )}

              {replyFromAi && (
                <div
                  role="status"
                  className="p-5 rounded-2xl border-2 border-teal-700 bg-teal-50/70 space-y-4"
                >
                  <p className="text-[26px] font-serif text-stone-950 leading-relaxed">
                    &ldquo;{replyFromAi}&rdquo;
                  </p>
                  <button
                    type="button"
                    onClick={() => speakAloud(replyFromAi)}
                    className="w-full min-h-[64px] px-5 rounded-2xl border-2 border-teal-800 bg-white text-teal-950 font-bold text-[22px] flex items-center justify-center gap-2.5 hover:bg-teal-50 transition-colors cursor-pointer"
                  >
                    <Volume2 className="w-6 h-6 shrink-0" aria-hidden="true" />
                    <span>Read reply aloud</span>
                  </button>
                </div>
              )}
            </section>
          </div>

          {/* Today's Schedule List */}
          <section
            aria-label="Today's pills"
            className="lg:col-span-5 p-6 rounded-2xl border border-stone-300 bg-white space-y-4"
          >
            <h2 className="text-[28px] font-bold text-stone-950">Today&apos;s pills</h2>

            {sortedDoses.length === 0 ? (
              <p className="text-[22px] text-stone-600">No pills scheduled for today.</p>
            ) : (
              <ul className="divide-y divide-stone-200">
                {sortedDoses.map((dose) => {
                  const med = medById.get(dose.medicationId);
                  if (!med) return null;
                  const timeLabel = formatClockTime(dose.scheduledFor);
                  const showPillPhoto = shouldShowPillImageForSenior(
                    dose,
                    clockNow,
                    state.settings.doseGraceMinutes,
                    leadMinutes
                  );
                  const pillImgSrc =
                    showPillPhoto && !failedPillImgIds[med.id]
                      ? resolveMedicationPillImage(med)
                      : null;

                  return (
                    <li key={dose.id} className="py-4 first:pt-1 last:pb-1 space-y-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex items-start gap-3.5 min-w-0">
                          {pillImgSrc && (
                            <img
                              src={pillImgSrc}
                              alt={`${med.name} ${med.strength} pill`}
                              referrerPolicy="no-referrer"
                              onError={() =>
                                setFailedPillImgIds((prev) => ({ ...prev, [med.id]: true }))
                              }
                              className="w-16 h-16 rounded-xl object-cover border-2 border-stone-300 bg-white shrink-0 mt-0.5"
                            />
                          )}
                          <div className="min-w-0">
                            <p className="text-[24px] font-bold text-stone-950">
                              {med.name}{' '}
                              <span className="font-normal text-stone-700">{med.strength}</span>
                            </p>
                            <p className="text-[20px] text-stone-700 tabular-nums">
                              {timeLabel} · {med.dose}
                              {med.purpose ? ` · ${med.purpose}` : ''}
                            </p>
                          </div>
                        </div>

                        <div className="shrink-0 text-right">
                          {dose.status === 'taken' && (
                            <span className="text-[20px] font-bold text-emerald-800">
                              ✓ Taken
                            </span>
                          )}
                          {dose.status === 'pending' &&
                            (dueDose?.id === dose.id ? (
                              <span className="text-[20px] font-bold text-amber-900">Due now</span>
                            ) : (
                              <span className="text-[20px] font-semibold text-stone-700">
                                Upcoming
                              </span>
                            ))}
                          {dose.status === 'missed' && (
                            <span className="text-[20px] font-bold text-red-800">Missed</span>
                          )}
                        </div>
                      </div>

                      {dose.status === 'missed' && (
                        <button
                          type="button"
                          disabled={takingDoseId === dose.id}
                          onClick={() => void handleMarkTaken(dose.id)}
                          className="w-full min-h-[64px] px-4 rounded-xl border-2 border-teal-800 bg-white text-teal-900 font-bold text-[20px] hover:bg-teal-50 transition-colors cursor-pointer"
                        >
                          I took {med.name} just now
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>
      </main>

      {/* Help Confirmation Modal */}
      {helpConfirmOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="help-dialog-title"
          className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
        >
          <div className="w-full max-w-lg rounded-3xl bg-white border-2 border-red-700 p-6 space-y-6 shadow-xl">
            <h2 id="help-dialog-title" className="text-[30px] font-bold text-stone-950">
              Send an alert to {state.settings.caregiverName}?
            </h2>
            <p className="text-[22px] text-stone-700 leading-relaxed">
              {state.settings.caregiverName} will get an urgent alert right away. For a medical
              emergency, call 911 immediately.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <button
                type="button"
                disabled={sendingHelp}
                onClick={() => void handleConfirmHelp()}
                className="w-full min-h-[68px] px-6 rounded-2xl bg-red-700 text-white font-bold text-[24px] hover:bg-red-800 disabled:opacity-60 transition-colors cursor-pointer"
              >
                {sendingHelp ? 'Alerting…' : 'Yes, send alert'}
              </button>
              <button
                type="button"
                disabled={sendingHelp}
                onClick={() => setHelpConfirmOpen(false)}
                className="w-full min-h-[68px] px-6 rounded-2xl border-2 border-stone-400 bg-white text-stone-900 font-bold text-[24px] hover:bg-stone-100 transition-colors cursor-pointer"
              >
                No
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Compact Sticky Bottom Help Bar (<= 84px height -> < 11% of mobile viewport) */}
      <div className="fixed bottom-0 inset-x-0 z-40 bg-white/95 backdrop-blur-sm border-t border-stone-300 px-4 pt-2.5 pb-safe">
        <div className="max-w-5xl mx-auto">
          <button
            type="button"
            onClick={() => setHelpConfirmOpen(true)}
            className="w-full min-h-[64px] px-6 rounded-2xl bg-red-700 text-white font-bold text-[24px] flex items-center justify-center gap-3 hover:bg-red-800 transition-colors cursor-pointer"
          >
            <ShieldAlert className="w-7 h-7 shrink-0" aria-hidden="true" />
            <span>I need help</span>
          </button>
        </div>
      </div>
    </div>
  );
};
