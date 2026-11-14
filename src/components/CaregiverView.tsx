import React, { useMemo, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  Bell,
  Camera,
  Check,
  HeartHandshake,
  ImagePlus,
  Loader2,
  MessageSquareHeart,
  Phone,
  Pill,
  Send,
  SlidersHorizontal,
  Sparkles,
  Sun,
  Trash2,
} from 'lucide-react';
import type { Alert, AppState, Medication, SeverityLevel } from '../shared/types';
import {
  assetUrlToDownscaledDataUrl,
  DEMO_IMAGES,
  downscaleBlobToDataUrl,
  formatCheckinTimestamp,
  formatClockTime,
  formatRelativeStartedOn,
  readApiJson,
  resolveMedicationPillImage,
} from '../utils/clientHelpers';
import { MedicationScanner } from './MedicationScanner';

interface CaregiverViewProps {
  state: AppState;
  onRefresh: () => Promise<void>;
  onNavigate: (path: '/' | '/senior' | '/caregiver') => void;
}

function getSeveritySurface(severity: SeverityLevel): {
  cardClass: string;
  labelClass: string;
  labelText: string;
} {
  switch (severity) {
    case 'urgent':
      return {
        cardClass: 'border-red-400 bg-red-50/70',
        labelClass: 'text-red-800 font-bold',
        labelText: 'Urgent safety alert',
      };
    case 'high':
      return {
        cardClass: 'border-red-300 bg-red-50/40',
        labelClass: 'text-red-700 font-semibold',
        labelText: 'High priority',
      };
    case 'medium':
      return {
        cardClass: 'border-amber-300 bg-amber-50/50',
        labelClass: 'text-amber-800 font-semibold',
        labelText: 'Needs attention',
      };
    default:
      return {
        cardClass: 'border-stone-300 bg-white',
        labelClass: 'text-teal-800 font-semibold',
        labelText: 'Connection note',
      };
  }
}

function formatStandaloneTimestamp(iso: string): string {
  const rel = formatCheckinTimestamp(iso);
  if (!rel) return 'Not recorded';
  if (rel.startsWith('at ')) {
    return `Today, ${rel.slice(3)}`;
  }
  if (rel.startsWith('yesterday at ')) {
    return `Yesterday, ${rel.slice('yesterday at '.length)}`;
  }
  return rel.replace(' at ', ', ');
}

function formatMoodLabel(mood: string): string {
  if (!mood) return 'No update yet';
  return mood.charAt(0).toUpperCase() + mood.slice(1);
}

export const CaregiverView: React.FC<CaregiverViewProps> = ({ state, onRefresh, onNavigate }) => {
  const [mobileTab, setMobileTab] = useState<'today' | 'alerts' | 'meds' | 'note'>('today');
  const [showAckAlerts, setShowAckAlerts] = useState(false);

  // Family message composer state
  const [msgText, setMsgText] = useState('');
  const [msgPhotoDataUrl, setMsgPhotoDataUrl] = useState<string | null>(null);
  const [sendingMsg, setSendingMsg] = useState(false);
  const [msgStatus, setMsgStatus] = useState<string | null>(null);

  // Demo controls state
  const [runningDemoAction, setRunningDemoAction] = useState<string | null>(null);

  // Inline medication startedOn, schedule times, and pill photo edit
  const [editingMedDateId, setEditingMedDateId] = useState<string | null>(null);
  const [editingMedTimesId, setEditingMedTimesId] = useState<string | null>(null);
  const [editingMedTimesValue, setEditingMedTimesValue] = useState('');
  const [failedPillImgIds, setFailedPillImgIds] = useState<Record<string, boolean>>({});

  const confirmedMedications = useMemo(
    () => state.medications.filter((m) => m.status === 'confirmed'),
    [state.medications]
  );

  const draftMedications = useMemo(
    () => state.medications.filter((m) => m.status === 'draft'),
    [state.medications]
  );

  const medByNameLower = useMemo(() => {
    const map = new Map<string, Medication>();
    for (const m of confirmedMedications) {
      map.set(m.name.toLowerCase(), m);
    }
    return map;
  }, [confirmedMedications]);

  const takenCount = state.doses.filter((d) => d.status === 'taken').length;
  const totalDosesCount = state.doses.length;
  const missedCount = state.doses.filter((d) => d.status === 'missed').length;

  const latestCheckin = state.checkins[0] || null;

  const activeAlerts = useMemo(
    () => state.alerts.filter((a) => !a.acknowledged),
    [state.alerts]
  );
  const displayedAlerts: Alert[] = showAckAlerts ? state.alerts : activeAlerts;

  const telHref = `tel:${state.settings.seniorPhone.replace(/\s+/g, '')}`;

  const handleLogContact = async () => {
    try {
      await fetch('/api/contact', { method: 'POST' });
      await onRefresh();
    } catch {
      // Allow tel: link navigation seamlessly
    }
  };

  const handleAckAlert = async (alertId: string) => {
    await fetch(`/api/alerts/${alertId}/ack`, { method: 'POST' });
    await onRefresh();
  };

  const handleDeleteMedication = async (medId: string) => {
    await fetch(`/api/medications/${medId}`, { method: 'DELETE' });
    await onRefresh();
  };

  const handleUpdateMedStartedOn = async (med: Medication, newDate: string) => {
    setEditingMedDateId(null);
    if (!newDate || newDate === med.startedOn) return;
    await fetch(`/api/medications/${med.id}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ startedOn: newDate }),
    });
    await onRefresh();
  };

  const parseScheduleTimesInput = (raw: string): string[] => {
    const parts = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const parsed: string[] = [];
    for (const part of parts) {
      const match = part.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
      if (!match) continue;
      let h = Number.parseInt(match[1], 10);
      const m = match[2] ? Number.parseInt(match[2], 10) : 0;
      const meridiem = match[3]?.toLowerCase();
      if (meridiem === 'pm' && h < 12) h += 12;
      if (meridiem === 'am' && h === 12) h = 0;
      if (h >= 0 && h <= 23 && m >= 0 && m <= 59) {
        parsed.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
      }
    }
    return parsed;
  };

  const handleSaveMedTimes = async (med: Medication) => {
    const parsedTimes = parseScheduleTimesInput(editingMedTimesValue);
    setEditingMedTimesId(null);
    if (parsedTimes.length === 0) return;
    await fetch(`/api/medications/${med.id}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ times: parsedTimes }),
    });
    await onRefresh();
  };

  const handleUpdateMedPillPhoto = async (
    med: Medication,
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const resized = await downscaleBlobToDataUrl(file, 600);
    setFailedPillImgIds((prev) => ({ ...prev, [med.id]: false }));
    await fetch(`/api/medications/${med.id}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pillPhotoDataUrl: resized }),
    });
    await onRefresh();
  };

  const handleMsgPhotoChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const resized = await downscaleBlobToDataUrl(file, 800);
    setMsgPhotoDataUrl(resized);
  };

  const handleAttachSamplePhoto = async () => {
    const resized = await assetUrlToDownscaledDataUrl(DEMO_IMAGES.familyGarden, 800);
    setMsgPhotoDataUrl(resized);
  };

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!msgText.trim() && !msgPhotoDataUrl) {
      setMsgStatus('Write a short note or attach a photo first.');
      return;
    }
    setSendingMsg(true);
    setMsgStatus(null);
    try {
      const res = await fetch('/api/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: msgText.trim(),
          photoDataUrl: msgPhotoDataUrl,
        }),
      });
      if (!res.ok) {
        const err = await readApiJson<{ error?: string }>(res, 'Could not send message.');
        throw new Error(err.error || 'Could not send message.');
      }
      setMsgText('');
      setMsgPhotoDataUrl(null);
      setMsgStatus(`Sent to ${state.settings.seniorName}'s screen.`);
      await onRefresh();
    } catch (err) {
      setMsgStatus(err instanceof Error ? err.message : 'Failed to send message.');
    } finally {
      setSendingMsg(false);
    }
  };

  const runDemoEndpoint = async (endpoint: string, label: string) => {
    setRunningDemoAction(label);
    try {
      await fetch(endpoint, { method: 'POST' });
      await onRefresh();
    } finally {
      setRunningDemoAction(null);
    }
  };

  return (
    <div className="min-h-screen bg-stone-50 text-stone-900 flex flex-col pb-24 md:pb-0 pt-safe">
      {/* Strict 3-Zone Top Bar Contract */}
      <header className="flex items-center justify-between gap-4 sm:gap-8 px-4 sm:px-6 lg:px-10 py-3.5 sm:py-4 border-b border-stone-200 bg-white">
        <a
          href="/"
          onClick={(e) => {
            e.preventDefault();
            onNavigate('/');
          }}
          className="text-lg font-bold tracking-tight text-stone-900 whitespace-nowrap shrink-0"
        >
          Huddle
        </a>

        <nav className="hidden md:flex items-center gap-6 text-sm font-semibold text-stone-600">
          <a
            href="#alerts-section"
            className="hover:text-stone-900 hover:underline underline-offset-4 transition-colors whitespace-nowrap shrink-0"
          >
            Alerts
          </a>
          <a
            href="#checkin-section"
            className="hover:text-stone-900 hover:underline underline-offset-4 transition-colors whitespace-nowrap shrink-0"
          >
            Latest Check-in
          </a>
          <a
            href="#medications-section"
            className="hover:text-stone-900 hover:underline underline-offset-4 transition-colors whitespace-nowrap shrink-0"
          >
            Medications
          </a>
          <a
            href="#message-section"
            className="hover:text-stone-900 hover:underline underline-offset-4 transition-colors whitespace-nowrap shrink-0"
          >
            Family Note
          </a>
          <a
            href="/senior"
            onClick={(e) => {
              e.preventDefault();
              onNavigate('/senior');
            }}
            className="hover:text-stone-900 hover:underline underline-offset-4 transition-colors whitespace-nowrap shrink-0"
          >
            {state.settings.seniorName}&apos;s View
          </a>
        </nav>

        <div className="flex items-center shrink-0">
          <a
            href={telHref}
            onClick={() => void handleLogContact()}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-teal-800 text-white text-sm font-semibold hover:bg-teal-900 transition-colors whitespace-nowrap shrink-0"
          >
            <Phone className="w-4 h-4" aria-hidden="true" />
            <span>Call {state.settings.seniorName}</span>
          </a>
        </div>
      </header>

      <main className="flex-1 max-w-6xl w-full mx-auto px-4 sm:px-5 lg:px-10 py-5 md:py-8 space-y-6 md:space-y-8">
        {/* Status Summary Header */}
        <section
          aria-label="Daily status summary"
          className={`${
            mobileTab === 'today' ? 'flex' : 'hidden md:flex'
          } p-5 sm:p-6 rounded-2xl border border-stone-200 bg-white flex-col gap-4`}
        >
          <div>
            <h1 className="text-xl sm:text-2xl font-bold text-stone-950 tracking-tight">
              {state.settings.seniorName}&apos;s Overview
            </h1>
            <p className="text-xs text-stone-500 mt-0.5">
              {state.settings.caregiverName}&apos;s caregiver dashboard
            </p>
          </div>

          <dl className="pt-4 border-t border-stone-100 divide-y divide-stone-100 md:divide-y-0 md:grid md:grid-cols-4 md:divide-x md:divide-stone-200">
            <div className="py-2.5 first:pt-0 last:pb-0 flex items-baseline justify-between gap-4 md:py-0 md:px-6 md:first:pl-0 md:last:pr-0 md:block md:space-y-1">
              <dt className="text-xs font-medium text-stone-500">Doses today</dt>
              <dd className="text-sm md:text-base font-semibold text-stone-900 tabular-nums">
                {takenCount} of {totalDosesCount} taken
                {missedCount > 0 && (
                  <span className="text-amber-800 font-semibold">
                    {' '}
                    · {missedCount} missed
                  </span>
                )}
              </dd>
            </div>

            <div className="py-2.5 first:pt-0 last:pb-0 flex items-baseline justify-between gap-4 md:py-0 md:px-6 md:first:pl-0 md:last:pr-0 md:block md:space-y-1">
              <dt className="text-xs font-medium text-stone-500">Latest check-in</dt>
              <dd className="text-sm md:text-base font-semibold text-stone-900 tabular-nums">
                {latestCheckin ? formatStandaloneTimestamp(latestCheckin.at) : 'No check-in yet'}
              </dd>
            </div>

            <div className="py-2.5 first:pt-0 last:pb-0 flex items-baseline justify-between gap-4 md:py-0 md:px-6 md:first:pl-0 md:last:pr-0 md:block md:space-y-1">
              <dt className="text-xs font-medium text-stone-500">Mood</dt>
              <dd className="text-sm md:text-base font-semibold text-stone-900">
                {latestCheckin ? formatMoodLabel(latestCheckin.mood) : 'No update yet'}
              </dd>
            </div>

            <div className="py-2.5 first:pt-0 last:pb-0 flex items-baseline justify-between gap-4 md:py-0 md:px-6 md:first:pl-0 md:last:pr-0 md:block md:space-y-1">
              <dt className="text-xs font-medium text-stone-500">Last called</dt>
              <dd className="text-sm md:text-base font-semibold text-stone-900 tabular-nums">
                {state.settings.lastContactAt
                  ? formatStandaloneTimestamp(state.settings.lastContactAt)
                  : 'Not logged yet'}
              </dd>
            </div>
          </dl>
        </section>

        {/* Main 2-Column Workspace */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 lg:gap-8 items-start">
          {/* Left Column: Alerts Feed + Latest Check-in */}
          <div className="lg:col-span-7 space-y-6 lg:space-y-8">
            {/* Alerts Feed */}
            <section
              id="alerts-section"
              className={`${mobileTab === 'alerts' ? 'block' : 'hidden md:block'} space-y-4`}
            >
              <div className="flex items-center justify-between gap-4">
                <div>
                  <h2 className="text-lg font-bold text-stone-900 tabular-nums">
                    Alerts &amp; Nudges ({activeAlerts.length} active)
                  </h2>
                  <p className="text-xs text-stone-500">
                    Every alert includes a suggested conversation opener.
                  </p>
                </div>
                {state.alerts.length > activeAlerts.length && (
                  <button
                    type="button"
                    onClick={() => setShowAckAlerts((prev) => !prev)}
                    className="text-xs font-semibold text-teal-800 hover:underline whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    {showAckAlerts ? 'Hide acknowledged' : 'Show acknowledged'}
                  </button>
                )}
              </div>

              {displayedAlerts.length === 0 ? (
                <div className="p-6 rounded-xl border border-stone-200 bg-white text-sm text-stone-600">
                  No active alerts right now. When a dose is missed, a check-in raises a question,
                  or it&apos;s been a few days since your last call, a warm prompt will appear here.
                </div>
              ) : (
                <div className="space-y-3">
                  {displayedAlerts.map((alert) => {
                    const style = getSeveritySurface(alert.severity);
                    return (
                      <article
                        key={alert.id}
                        className={`p-5 rounded-xl border ${style.cardClass} ${
                          alert.acknowledged ? 'opacity-65' : ''
                        } space-y-3`}
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                          <div className="flex items-center gap-2">
                            {alert.severity === 'urgent' || alert.severity === 'high' ? (
                              <AlertCircle className="w-4 h-4 text-red-700" aria-hidden="true" />
                            ) : alert.severity === 'medium' ? (
                              <AlertTriangle className="w-4 h-4 text-amber-700" aria-hidden="true" />
                            ) : (
                              <Sparkles className="w-4 h-4 text-teal-800" aria-hidden="true" />
                            )}
                            <span className={style.labelClass}>{style.labelText}</span>
                            <span aria-hidden="true" className="text-stone-400">
                              ·
                            </span>
                            <span className="text-stone-500 tabular-nums">
                              {formatCheckinTimestamp(alert.at)}
                            </span>
                          </div>
                          {alert.acknowledged && (
                            <span className="text-stone-500 font-medium">Acknowledged</span>
                          )}
                        </div>

                        <div>
                          <h3 className="text-base font-bold text-stone-950">{alert.title}</h3>
                          <p className="text-sm text-stone-700 mt-1 leading-relaxed">
                            {alert.body}
                          </p>
                        </div>

                        {alert.suggestedOpener && (
                          <div className="p-3.5 rounded-lg bg-white/90 border border-stone-200/80">
                            <p className="text-xs font-semibold text-stone-500 mb-0.5">
                              Try saying:
                            </p>
                            <p className="text-sm font-serif text-stone-900 leading-relaxed">
                              &ldquo;{alert.suggestedOpener}&rdquo;
                            </p>
                          </div>
                        )}

                        <div className="flex flex-wrap items-center gap-2.5 pt-1">
                          <a
                            href={telHref}
                            onClick={() => void handleLogContact()}
                            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-teal-800 text-white text-xs font-semibold hover:bg-teal-900 transition-colors whitespace-nowrap shrink-0"
                          >
                            <Phone className="w-3.5 h-3.5" aria-hidden="true" />
                            <span>Call {state.settings.seniorName}</span>
                          </a>
                          {!alert.acknowledged && (
                            <button
                              type="button"
                              onClick={() => void handleAckAlert(alert.id)}
                              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-stone-300 bg-white text-stone-700 text-xs font-semibold hover:bg-stone-100 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                            >
                              <Check className="w-3.5 h-3.5" aria-hidden="true" />
                              <span>Acknowledge</span>
                            </button>
                          )}
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
            </section>

            {/* Latest Check-In Card */}
            <section
              id="checkin-section"
              className={`${
                mobileTab === 'today' ? 'block' : 'hidden md:block'
              } p-5 sm:p-6 rounded-2xl border border-stone-200 bg-white space-y-5`}
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2 pb-3 border-b border-stone-100">
                <h2 className="text-lg font-bold text-stone-900">Latest Daily Check-in</h2>
                {latestCheckin && (
                  <p className="text-xs text-stone-500 tabular-nums">
                    {formatCheckinTimestamp(latestCheckin.at)} · Mood: {latestCheckin.mood}
                  </p>
                )}
              </div>

              {!latestCheckin ? (
                <p className="text-sm text-stone-600">
                  No check-ins recorded yet. When {state.settings.seniorName} shares a daily
                  check-in, her summary, bright spots, and any health notes will appear here.
                </p>
              ) : (
                <div className="space-y-5">
                  <p className="text-base text-stone-900 leading-relaxed">
                    {latestCheckin.summary}
                  </p>

                  {/* Concerns with possibleMedication + startedOn correlation */}
                  {latestCheckin.concerns.length > 0 && (
                    <div className="space-y-2.5">
                      <h3 className="text-xs font-bold text-stone-700">
                        Health &amp; safety notes (not medical advice)
                      </h3>
                      <ul className="space-y-2">
                        {latestCheckin.concerns.map((concern, idx) => {
                          const linkedMed = concern.possibleMedication
                            ? medByNameLower.get(concern.possibleMedication.toLowerCase()) || null
                            : null;

                          return (
                            <li
                              key={idx}
                              className="p-3.5 rounded-xl border border-amber-300 bg-amber-50/60 text-sm text-stone-900 space-y-1"
                            >
                              <div className="flex items-center justify-between gap-2">
                                <span className="font-semibold">{concern.text}</span>
                                <span className="text-xs font-semibold text-amber-900">
                                  Severity: {concern.severity}
                                </span>
                              </div>
                              {concern.possibleMedication && (
                                <p className="text-xs text-amber-950">
                                  Possible link to{' '}
                                  <span className="font-semibold">
                                    {concern.possibleMedication}
                                  </span>
                                  {linkedMed
                                    ? `, ${formatRelativeStartedOn(linkedMed.startedOn)}`
                                    : ''}{' '}
                                  — ask your pharmacist or doctor about whether this could be
                                  related.
                                </p>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  )}

                  {/* Good Moments Section */}
                  {latestCheckin.goodMoments.length > 0 && (
                    <div className="p-4 rounded-xl bg-teal-50/70 space-y-2">
                      <div className="flex items-center gap-2 text-teal-900">
                        <Sun className="w-4 h-4 shrink-0" aria-hidden="true" />
                        <h3 className="text-sm font-bold">Good moments</h3>
                      </div>
                      <ul className="space-y-1 text-sm text-stone-800">
                        {latestCheckin.goodMoments.map((moment, idx) => (
                          <li key={idx}>• {moment}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* Suggested Conversation Opener */}
                  {latestCheckin.suggestedOpener && (
                    <div className="p-4 rounded-xl bg-stone-100/80 space-y-1">
                      <p className="text-xs font-semibold text-stone-600">
                        Suggested call opener:
                      </p>
                      <p className="text-base font-serif text-stone-900">
                        &ldquo;{latestCheckin.suggestedOpener}&rdquo;
                      </p>
                    </div>
                  )}

                  {/* Transcript or Privacy Notice */}
                  <div className="pt-2 border-t border-stone-100">
                    {typeof latestCheckin.transcript === 'string' ? (
                      <div className="space-y-1">
                        <p className="text-xs font-semibold text-stone-500">
                          {state.settings.seniorName}&apos;s words:
                        </p>
                        <p className="text-sm font-serif text-stone-700 italic leading-relaxed">
                          &ldquo;{latestCheckin.transcript}&rdquo;
                        </p>
                      </div>
                    ) : (
                      <p className="text-xs font-medium text-stone-500 italic">
                        {state.settings.seniorName} kept her words private (summary, good moments,
                        and urgent safety notes are still shared).
                      </p>
                    )}
                  </div>
                </div>
              )}
            </section>
          </div>

          {/* Right Column: Medications + Send Family Message */}
          <div className="lg:col-span-5 space-y-6 lg:space-y-8">
            {/* Medications Management + Scanner */}
            <section
              id="medications-section"
              className={`${
                mobileTab === 'meds' ? 'block' : 'hidden md:block'
              } p-5 sm:p-6 rounded-2xl border border-stone-200 bg-white space-y-5`}
            >
              <MedicationScanner drafts={draftMedications} onRefresh={onRefresh} />

              <div className="divide-y divide-stone-200 pt-2">
                {confirmedMedications.length === 0 ? (
                  <p className="text-sm text-stone-500 py-4">
                    No confirmed medications yet. Use &ldquo;Add by photo&rdquo; above to scan a
                    bottle.
                  </p>
                ) : (
                  confirmedMedications.map((med) => {
                    const pillImgSrc = resolveMedicationPillImage(med);
                    const hasValidImg = Boolean(pillImgSrc && !failedPillImgIds[med.id]);

                    return (
                      <div key={med.id} className="py-4 first:pt-2 last:pb-1 space-y-2.5">
                        <div className="flex items-start gap-3.5">
                          {/* Actual Pill Photo Thumbnail */}
                          <div className="shrink-0 flex flex-col items-center gap-1">
                            {hasValidImg ? (
                              <img
                                src={pillImgSrc!}
                                alt={`${med.name} ${med.strength} pill`}
                                referrerPolicy="no-referrer"
                                onError={() =>
                                  setFailedPillImgIds((prev) => ({ ...prev, [med.id]: true }))
                                }
                                className="w-16 h-16 rounded-xl object-cover border border-stone-200 bg-stone-100"
                              />
                            ) : (
                              <div className="w-16 h-16 rounded-xl border border-dashed border-stone-300 bg-stone-50 flex items-center justify-center text-stone-400">
                                <Pill className="w-6 h-6" aria-hidden="true" />
                              </div>
                            )}
                            <label
                              htmlFor={`med-pill-photo-${med.id}`}
                              className="inline-flex items-center gap-1 text-[11px] font-semibold text-teal-800 hover:underline cursor-pointer whitespace-nowrap"
                            >
                              <Camera className="w-3 h-3" aria-hidden="true" />
                              <span>{hasValidImg ? 'Edit pill' : 'Add pill'}</span>
                              <input
                                id={`med-pill-photo-${med.id}`}
                                type="file"
                                accept="image/*"
                                capture="environment"
                                onChange={(e) => void handleUpdateMedPillPhoto(med, e)}
                                className="sr-only"
                              />
                            </label>
                          </div>

                          <div className="flex-1 min-w-0 space-y-1.5">
                            <div className="flex items-start justify-between gap-2">
                              <div className="space-y-1 min-w-0">
                                <h4 className="text-base font-bold text-stone-900">
                                  {med.name}{' '}
                                  <span className="font-normal text-stone-600">{med.strength}</span>
                                </h4>
                                <p className="text-xs text-stone-600 tabular-nums">
                                  {med.dose} · {med.times.map(formatClockTime).join(', ')}{' '}
                                  {editingMedTimesId !== med.id && (
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setEditingMedTimesId(med.id);
                                        setEditingMedTimesValue(med.times.join(', '));
                                      }}
                                      aria-label={`Edit schedule times for ${med.name}`}
                                      className="underline decoration-dotted underline-offset-2 text-teal-800 hover:text-stone-900 cursor-pointer"
                                    >
                                      (edit times)
                                    </button>
                                  )}
                                  {med.withFood ? ' · With food' : ''}
                                  {med.purpose ? ` · ${med.purpose}` : ''}
                                </p>
                                {editingMedTimesId === med.id && (
                                  <div className="flex flex-wrap items-center gap-2 pt-1">
                                    <input
                                      type="text"
                                      value={editingMedTimesValue}
                                      onChange={(e) => setEditingMedTimesValue(e.target.value)}
                                      aria-label={`Schedule times for ${med.name}`}
                                      placeholder="08:00, 20:00"
                                      onKeyDown={(e) => {
                                        if (e.key === 'Enter') {
                                          e.preventDefault();
                                          void handleSaveMedTimes(med);
                                        } else if (e.key === 'Escape') {
                                          setEditingMedTimesId(null);
                                        }
                                      }}
                                      className="w-40 px-2.5 py-1 rounded-lg border border-stone-300 text-xs font-mono tabular-nums text-stone-900"
                                    />
                                    <button
                                      type="button"
                                      onClick={() => void handleSaveMedTimes(med)}
                                      className="px-2.5 py-1 rounded-lg bg-teal-800 text-white text-xs font-semibold hover:bg-teal-900 cursor-pointer"
                                    >
                                      Save
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => setEditingMedTimesId(null)}
                                      className="px-2.5 py-1 rounded-lg border border-stone-300 bg-white text-stone-700 text-xs font-semibold hover:bg-stone-100 cursor-pointer"
                                    >
                                      Cancel
                                    </button>
                                  </div>
                                )}
                              </div>

                              <button
                                type="button"
                                onClick={() => void handleDeleteMedication(med.id)}
                                aria-label={`Remove ${med.name}`}
                                className="p-2 rounded-lg text-stone-400 hover:text-red-700 hover:bg-stone-100 transition-colors cursor-pointer shrink-0"
                              >
                                <Trash2 className="w-4 h-4" aria-hidden="true" />
                              </button>
                            </div>

                            <div className="flex flex-wrap items-center gap-2 text-xs text-stone-500">
                              <span>{med.instructions}</span>
                              <span aria-hidden="true">·</span>
                              {editingMedDateId === med.id ? (
                                <input
                                  type="date"
                                  defaultValue={med.startedOn}
                                  aria-label={`Start date for ${med.name}`}
                                  onBlur={(e) =>
                                    void handleUpdateMedStartedOn(med, e.target.value)
                                  }
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                      void handleUpdateMedStartedOn(
                                        med,
                                        (e.target as HTMLInputElement).value
                                      );
                                    }
                                  }}
                                  className="px-2 py-0.5 rounded border border-stone-300 text-xs font-mono tabular-nums text-stone-900"
                                />
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => setEditingMedDateId(med.id)}
                                  className="underline decoration-dotted underline-offset-2 hover:text-stone-900 cursor-pointer"
                                >
                                  {formatRelativeStartedOn(med.startedOn)} (edit)
                                </button>
                              )}
                            </div>

                            {med.pharmacistQuestions.length > 0 && (
                              <div className="p-2.5 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-950">
                                {med.pharmacistQuestions.join(' · ')}
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </section>

            {/* Send Margaret a Message */}
            <section
              id="message-section"
              className={`${
                mobileTab === 'note' ? 'block' : 'hidden md:block'
              } p-5 sm:p-6 rounded-2xl border border-stone-200 bg-white space-y-4`}
            >
              <div>
                <h2 className="text-lg font-bold text-stone-900">
                  Send {state.settings.seniorName} a Message
                </h2>
                <p className="text-xs text-stone-500">
                  Appears in large print on her screen with one-tap read-aloud.
                </p>
              </div>

              <form onSubmit={handleSendMessage} className="space-y-3">
                <div>
                  <label htmlFor="family-msg-input" className="sr-only">
                    Message for {state.settings.seniorName}
                  </label>
                  <textarea
                    id="family-msg-input"
                    rows={3}
                    value={msgText}
                    onChange={(e) => setMsgText(e.target.value)}
                    placeholder={`Hi Mom! Thinking of you today — save me one of those garden tomatoes!`}
                    className="w-full p-3 rounded-xl border border-stone-300 bg-stone-50 text-sm text-stone-900 focus:outline-none focus:ring-2 focus:ring-teal-700"
                  />
                </div>

                {msgPhotoDataUrl && (
                  <div className="flex items-center gap-3 p-2.5 rounded-xl border border-stone-200 bg-stone-50">
                    <img
                      src={msgPhotoDataUrl}
                      alt="Attached family photo preview"
                      referrerPolicy="no-referrer"
                      className="w-16 h-16 rounded-lg object-cover border border-stone-200"
                    />
                    <div className="flex-1 text-xs">
                      <p className="font-semibold text-stone-800">Photo attached (≤800px)</p>
                      <button
                        type="button"
                        onClick={() => setMsgPhotoDataUrl(null)}
                        className="text-red-700 hover:underline mt-0.5 cursor-pointer"
                      >
                        Remove photo
                      </button>
                    </div>
                  </div>
                )}

                <div className="flex flex-wrap items-center gap-2">
                  <label
                    htmlFor="family-photo-upload"
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-stone-300 bg-white text-xs font-semibold text-stone-700 hover:bg-stone-100 cursor-pointer whitespace-nowrap shrink-0"
                  >
                    <ImagePlus className="w-4 h-4 text-teal-800" aria-hidden="true" />
                    <span>Attach photo</span>
                    <input
                      id="family-photo-upload"
                      type="file"
                      accept="image/*"
                      onChange={(e) => void handleMsgPhotoChange(e)}
                      className="sr-only"
                    />
                  </label>

                  <button
                    type="button"
                    onClick={() => void handleAttachSamplePhoto()}
                    className="px-3 py-2 rounded-lg border border-stone-300 bg-white text-xs font-semibold text-stone-700 hover:bg-stone-100 whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    Use sample kitchen photo
                  </button>
                </div>

                <button
                  type="submit"
                  disabled={sendingMsg}
                  className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-teal-800 text-white text-sm font-semibold hover:bg-teal-900 disabled:opacity-60 transition-colors cursor-pointer"
                >
                  {sendingMsg ? (
                    <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <Send className="w-4 h-4" aria-hidden="true" />
                  )}
                  <span>Send to {state.settings.seniorName}</span>
                </button>

                {msgStatus && <p className="text-xs font-medium text-teal-900">{msgStatus}</p>}
              </form>

              {state.messages.length > 0 && (
                <div className="pt-3 border-t border-stone-100 space-y-2">
                  <p className="text-xs font-semibold text-stone-500">Recent family notes</p>
                  <ul className="space-y-1.5 text-xs text-stone-600">
                    {state.messages.slice(0, 3).map((m) => (
                      <li key={m.id} className="flex items-center justify-between gap-2">
                        <span className="truncate">
                          {m.text || '(Photo message)'}
                        </span>
                        <span className="shrink-0 tabular-nums text-stone-500">
                          {m.playedAt
                            ? `Read ${formatCheckinTimestamp(m.playedAt)}`
                            : 'Unread on screen'}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </section>
          </div>
        </div>

        {/* Collapsible Demo Controls */}
        <details
          className={`${
            mobileTab === 'note' || mobileTab === 'today' ? 'block' : 'hidden md:block'
          } rounded-2xl border border-stone-200 bg-white p-5`}
        >
          <summary className="flex items-center justify-between cursor-pointer text-sm font-bold text-stone-800 select-none">
            <span className="inline-flex items-center gap-2">
              <SlidersHorizontal className="w-4 h-4 text-stone-500" aria-hidden="true" />
              <span>Demo controls</span>
            </span>
            <span className="hidden sm:inline text-xs font-normal text-stone-500">
              Trigger a live pill reminder, simulate missed doses, 6-day contact nudges, or reset
            </span>
          </summary>

          <div className="mt-4 pt-4 border-t border-stone-100 flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={runningDemoAction !== null}
              onClick={() => void runDemoEndpoint('/api/demo/due-now', 'duenow')}
              className="px-4 py-2 rounded-lg border border-teal-300 bg-teal-50 text-xs font-semibold text-teal-950 hover:bg-teal-100 disabled:opacity-60 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              {runningDemoAction === 'duenow' ? 'Triggering…' : 'Simulate pill due now'}
            </button>

            <button
              type="button"
              disabled={runningDemoAction !== null}
              onClick={() => void runDemoEndpoint('/api/demo/miss-dose', 'miss')}
              className="px-4 py-2 rounded-lg border border-stone-300 bg-stone-50 text-xs font-semibold text-stone-800 hover:bg-stone-100 disabled:opacity-60 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              {runningDemoAction === 'miss' ? 'Simulating…' : 'Simulate missed dose'}
            </button>

            <button
              type="button"
              disabled={runningDemoAction !== null}
              onClick={() => void runDemoEndpoint('/api/demo/no-contact', 'nocontact')}
              className="px-4 py-2 rounded-lg border border-stone-300 bg-stone-50 text-xs font-semibold text-stone-800 hover:bg-stone-100 disabled:opacity-60 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              {runningDemoAction === 'nocontact' ? 'Simulating…' : 'Simulate 6 days no contact'}
            </button>

            <button
              type="button"
              disabled={runningDemoAction !== null}
              onClick={() => void runDemoEndpoint('/api/demo/reset', 'reset')}
              className="px-4 py-2 rounded-lg border border-red-200 bg-red-50 text-xs font-semibold text-red-900 hover:bg-red-100 disabled:opacity-60 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              {runningDemoAction === 'reset' ? 'Resetting…' : 'Reset demo'}
            </button>
          </div>
        </details>
      </main>

      {/* Mobile App Bottom Tab Navigation (md:hidden -> thumb zone, < 9% viewport height) */}
      <nav
        aria-label="Caregiver mobile navigation"
        className="md:hidden fixed bottom-0 inset-x-0 z-40 bg-white/95 backdrop-blur-md border-t border-stone-200 pb-safe"
      >
        <div className="grid grid-cols-4 items-center h-16">
          <button
            type="button"
            onClick={() => {
              setMobileTab('today');
              window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
            }}
            className={`min-h-[48px] flex flex-col items-center justify-center gap-0.5 cursor-pointer transition-colors ${
              mobileTab === 'today' ? 'text-teal-800 font-bold' : 'text-stone-500 font-medium'
            }`}
          >
            <HeartHandshake className="w-5 h-5" aria-hidden="true" />
            <span className="text-[11px] tracking-tight whitespace-nowrap">Today</span>
          </button>

          <button
            type="button"
            onClick={() => {
              setMobileTab('alerts');
              window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
            }}
            className={`min-h-[48px] flex flex-col items-center justify-center gap-0.5 cursor-pointer transition-colors ${
              mobileTab === 'alerts' ? 'text-teal-800 font-bold' : 'text-stone-500 font-medium'
            }`}
          >
            <Bell className="w-5 h-5" aria-hidden="true" />
            <span className="text-[11px] tracking-tight tabular-nums whitespace-nowrap">
              {activeAlerts.length > 0 ? `Alerts (${activeAlerts.length})` : 'Alerts'}
            </span>
          </button>

          <button
            type="button"
            onClick={() => {
              setMobileTab('meds');
              window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
            }}
            className={`min-h-[48px] flex flex-col items-center justify-center gap-0.5 cursor-pointer transition-colors ${
              mobileTab === 'meds' ? 'text-teal-800 font-bold' : 'text-stone-500 font-medium'
            }`}
          >
            <Pill className="w-5 h-5" aria-hidden="true" />
            <span className="text-[11px] tracking-tight whitespace-nowrap">Meds</span>
          </button>

          <button
            type="button"
            onClick={() => {
              setMobileTab('note');
              window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
            }}
            className={`min-h-[48px] flex flex-col items-center justify-center gap-0.5 cursor-pointer transition-colors ${
              mobileTab === 'note' ? 'text-teal-800 font-bold' : 'text-stone-500 font-medium'
            }`}
          >
            <MessageSquareHeart className="w-5 h-5" aria-hidden="true" />
            <span className="text-[11px] tracking-tight whitespace-nowrap">Note</span>
          </button>
        </div>
      </nav>
    </div>
  );
};
