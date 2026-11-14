import type {
  Alert,
  AppState,
  CheckIn,
  CheckInAIOutput,
  CheckInConcern,
  DoseEvent,
  FamilyMessage,
  Medication,
  MoodLevel,
  SeverityLevel,
} from './types.ts';

export const REMINDER_LEAD_MINUTES = 15;
export const DEFAULT_GEMINI_MODEL = 'gemini-4-hydrogen';

export const URGENT_SAFETY_REGEX =
  /chest pain|can't breathe|cannot breathe|fell and can't|i fell|stroke|want to die|kill myself|end my life/i;

export const SELF_HARM_REGEX = /want to die|kill myself|end my life/i;

export function resolveGeminiModelName(rawEnvModel?: string): string {
  if (typeof rawEnvModel !== 'string') return DEFAULT_GEMINI_MODEL;
  const cleaned = rawEnvModel
    .trim()
    .replace(/^["']+|["']+$/g, '')
    .replace(/^models\//i, '')
    .trim();

  if (!cleaned) return DEFAULT_GEMINI_MODEL;

  // Accept only valid non-deprecated Gemini 2.5 / 3 / 4 model IDs; ignore keys, URLs, Claude names, or malformed strings
  if (/^gemini-(?:2\.5|3|4)[a-z0-9.-]*$/.test(cleaned)) {
    return cleaned;
  }
  return DEFAULT_GEMINI_MODEL;
}

export function makeId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function resolveTzOffset(now: Date, tzOffsetMinutes?: number): number {
  if (typeof tzOffsetMinutes === 'number' && Number.isFinite(tzOffsetMinutes)) {
    return tzOffsetMinutes;
  }
  return now.getTimezoneOffset();
}

export function toLocalDateKey(date: Date, tzOffsetMinutes?: number): string {
  const offset = resolveTzOffset(date, tzOffsetMinutes);
  const shifted = new Date(date.getTime() - offset * 60 * 1000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function buildScheduledIso(
  baseDate: Date,
  hhmm: string,
  tzOffsetMinutes?: number
): string {
  const offset = resolveTzOffset(baseDate, tzOffsetMinutes);
  const shifted = new Date(baseDate.getTime() - offset * 60 * 1000);
  const [rawH, rawM] = hhmm.split(':');
  const hours = Number.parseInt(rawH || '8', 10);
  const minutes = Number.parseInt(rawM || '0', 10);
  const utcMs =
    Date.UTC(
      shifted.getUTCFullYear(),
      shifted.getUTCMonth(),
      shifted.getUTCDate(),
      Number.isFinite(hours) ? hours : 8,
      Number.isFinite(minutes) ? minutes : 0,
      0,
      0
    ) +
    offset * 60 * 1000;
  return new Date(utcMs).toISOString();
}

export function getLocalHourMinute(
  isoString: string,
  tzOffsetMinutes?: number
): { hours: number; minutes: number } {
  const d = new Date(isoString);
  const offset = resolveTzOffset(d, tzOffsetMinutes);
  const shifted = new Date(d.getTime() - offset * 60 * 1000);
  return {
    hours: shifted.getUTCHours(),
    minutes: shifted.getUTCMinutes(),
  };
}

export function isSameLocalDay(
  isoString: string,
  refDate: Date,
  tzOffsetMinutes?: number
): boolean {
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return false;
  return toLocalDateKey(d, tzOffsetMinutes) === toLocalDateKey(refDate, tzOffsetMinutes);
}

export function isDoseInReminderWindow(
  dose: DoseEvent,
  now: Date,
  graceMinutes: number = 30,
  leadMinutes: number = REMINDER_LEAD_MINUTES
): boolean {
  if (dose.status !== 'pending') return false;
  if (dose.remindedAt !== null) return true;

  const scheduledMs = new Date(dose.scheduledFor).getTime();
  if (Number.isNaN(scheduledMs)) return false;

  const nowMs = now.getTime();
  const leadMs = Math.max(0, leadMinutes) * 60 * 1000;
  const graceMs = Math.max(1, graceMinutes) * 60 * 1000;

  return nowMs >= scheduledMs - leadMs && nowMs <= scheduledMs + graceMs;
}

export function shouldShowPillImageForSenior(
  dose: DoseEvent,
  now: Date,
  graceMinutes: number = 30,
  leadMinutes: number = REMINDER_LEAD_MINUTES
): boolean {
  if (dose.status === 'taken') return false;
  if (dose.status === 'missed') return true;
  return isDoseInReminderWindow(dose, now, graceMinutes, leadMinutes);
}

export function daysAgoDateString(
  now: Date,
  daysAgo: number,
  tzOffsetMinutes?: number
): string {
  const d = new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000);
  return toLocalDateKey(d, tzOffsetMinutes);
}

export function daysSinceDate(isoOrDate: string, now: Date): number {
  const parsed = new Date(isoOrDate.length === 10 ? `${isoOrDate}T00:00:00` : isoOrDate);
  if (Number.isNaN(parsed.getTime())) return 0;
  const diffMs = now.getTime() - parsed.getTime();
  return Math.max(0, Math.floor(diffMs / (24 * 60 * 60 * 1000)));
}

export function formatTimeOfDayBucket(
  hhmmOrIso: string,
  tzOffsetMinutes?: number
): string {
  let hour = 8;
  if (hhmmOrIso.includes('T')) {
    hour = getLocalHourMinute(hhmmOrIso, tzOffsetMinutes).hours;
  } else {
    hour = Number.parseInt(hhmmOrIso.split(':')[0] || '8', 10);
  }
  if (hour < 12) return 'morning';
  if (hour < 17) return 'afternoon';
  if (hour < 20) return 'evening';
  return 'bedtime';
}

export function createSeedState(
  now: Date = new Date(),
  protectedPastDoseIds?: Set<string>,
  tzOffsetMinutes?: number
): AppState {
  if (protectedPastDoseIds) {
    protectedPastDoseIds.clear();
  }

  const tz = resolveTzOffset(now, tzOffsetMinutes);
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const yesterdayBase = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const yesterdayCheckinIso = buildScheduledIso(yesterdayBase, '09:15', tz);

  const metforminId = 'med_metformin';
  const atorvastatinId = 'med_atorvastatin';
  const lisinoprilId = 'med_lisinopril';

  const medications: Medication[] = [
    {
      id: metforminId,
      name: 'Metformin',
      strength: '500 mg',
      dose: '1 tablet',
      instructions: 'Take twice daily with food',
      times: ['08:00', '20:00'],
      withFood: true,
      purpose: 'for blood sugar',
      startedOn: daysAgoDateString(now, 730, tz),
      status: 'confirmed',
      confidence: 'high',
      unreadableFields: [],
      pharmacistQuestions: [],
    },
    {
      id: atorvastatinId,
      name: 'Atorvastatin',
      strength: '20 mg',
      dose: '1 tablet',
      instructions: 'Take once daily at bedtime',
      times: ['21:00'],
      withFood: null,
      purpose: 'for cholesterol',
      startedOn: daysAgoDateString(now, 365, tz),
      status: 'confirmed',
      confidence: 'high',
      unreadableFields: [],
      pharmacistQuestions: [],
    },
    {
      id: lisinoprilId,
      name: 'Lisinopril',
      strength: '10 mg',
      dose: '1 tablet',
      instructions: 'Take once daily in the morning',
      times: ['08:00'],
      withFood: null,
      purpose: 'for blood pressure',
      startedOn: daysAgoDateString(now, 3, tz),
      status: 'confirmed',
      confidence: 'high',
      unreadableFields: [],
      pharmacistQuestions: [],
    },
  ];

  const doses: DoseEvent[] = [
    {
      id: 'dose_metformin_am',
      medicationId: metforminId,
      scheduledFor: buildScheduledIso(now, '08:00', tz),
      status: 'taken',
      remindedAt: null,
      takenAt: buildScheduledIso(now, '08:04', tz),
    },
    {
      id: 'dose_lisinopril_am',
      medicationId: lisinoprilId,
      scheduledFor: buildScheduledIso(now, '08:00', tz),
      status: 'pending',
      remindedAt: null,
      takenAt: null,
    },
    {
      id: 'dose_metformin_pm',
      medicationId: metforminId,
      scheduledFor: buildScheduledIso(now, '20:00', tz),
      status: 'pending',
      remindedAt: null,
      takenAt: null,
    },
    {
      id: 'dose_atorvastatin_pm',
      medicationId: atorvastatinId,
      scheduledFor: buildScheduledIso(now, '21:00', tz),
      status: 'pending',
      remindedAt: null,
      takenAt: null,
    },
  ];

  if (protectedPastDoseIds) {
    for (const d of doses) {
      if (d.status === 'pending' && new Date(d.scheduledFor).getTime() <= now.getTime()) {
        protectedPastDoseIds.add(d.id);
      }
    }
  }

  const checkins: CheckIn[] = [
    {
      id: 'checkin_seed_yesterday',
      at: yesterdayCheckinIso,
      transcript:
        'Feeling pretty good this morning! I went out to the garden after breakfast and saw my tomatoes finally came in.',
      keptPrivate: false,
      summary:
        'Margaret had a bright morning and enjoyed time outside in her garden after breakfast.',
      mood: 'good',
      concerns: [],
      goodMoments: ['Her tomatoes finally came in'],
      suggestedOpener:
        'Hi Mom! I heard your garden tomatoes finally came in — what are you planning to make with the first batch?',
      urgent: false,
    },
  ];

  return {
    settings: {
      seniorName: 'Margaret',
      seniorPhone: '+1 555 555 0100',
      caregiverName: 'Priya',
      caregiverPhone: '+1 555 555 0101',
      shareCheckinWords: true,
      lastContactAt: oneDayAgo.toISOString(),
      noContactNudgeDays: 5,
      doseGraceMinutes: 30,
      reminderLeadMinutes: REMINDER_LEAD_MINUTES,
      tzOffsetMinutes: tz,
    },
    medications,
    doses,
    checkins,
    alerts: [],
    messages: [],
  };
}

export function syncTimezoneOffset(
  state: AppState,
  clientTzOffset: number,
  now: Date = new Date(),
  protectedPastDoseIds?: Set<string>
): boolean {
  if (!Number.isFinite(clientTzOffset) || clientTzOffset < -840 || clientTzOffset > 840) {
    return false;
  }
  const previousTz = state.settings.tzOffsetMinutes;
  if (previousTz === clientTzOffset) {
    return false;
  }

  const oldTz = typeof previousTz === 'number' ? previousTz : now.getTimezoneOffset();
  state.settings.tzOffsetMinutes = clientTzOffset;
  const graceMs = Math.max(1, state.settings.doseGraceMinutes) * 60 * 1000;

  for (const dose of state.doses) {
    if (isSameLocalDay(dose.scheduledFor, now, oldTz) || isSameLocalDay(dose.scheduledFor, now, clientTzOffset)) {
      if (dose.status === 'pending' && dose.remindedAt !== null) {
        continue;
      }
      const hm = getLocalHourMinute(dose.scheduledFor, oldTz);
      const hhmm = `${String(hm.hours).padStart(2, '0')}:${String(hm.minutes).padStart(2, '0')}`;
      dose.scheduledFor = buildScheduledIso(now, hhmm, clientTzOffset);

      if (dose.status === 'pending' && protectedPastDoseIds) {
        if (new Date(dose.scheduledFor).getTime() + graceMs < now.getTime()) {
          protectedPastDoseIds.add(dose.id);
        } else {
          protectedPastDoseIds.delete(dose.id);
        }
      }
    }
  }

  for (const med of state.medications) {
    if (med.status === 'confirmed') {
      ensureTodayDosesForMedication(state, med, now, protectedPastDoseIds);
    }
  }
  return true;
}

export function buildPublicState(
  state: AppState,
  view: 'senior' | 'caregiver' = 'senior',
  now: Date = new Date()
): AppState {
  const tz = state.settings.tzOffsetMinutes;
  const todayDoses = state.doses
    .filter((d) => isSameLocalDay(d.scheduledFor, now, tz))
    .sort((a, b) => new Date(a.scheduledFor).getTime() - new Date(b.scheduledFor).getTime());

  const recentCheckins = [...state.checkins]
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
    .slice(0, 10)
    .map((c) => {
      if (view === 'caregiver' && (c.keptPrivate || !state.settings.shareCheckinWords)) {
        const sanitized: CheckIn = {
          id: c.id,
          at: c.at,
          keptPrivate: c.keptPrivate,
          summary: c.summary,
          mood: c.mood,
          concerns: c.concerns,
          goodMoments: c.goodMoments,
          suggestedOpener: c.suggestedOpener,
          urgent: c.urgent,
        };
        return sanitized;
      }
      return { ...c };
    });

  const recentAlerts = [...state.alerts]
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
    .slice(0, 30);

  const sortedMessages = [...state.messages].sort(
    (a, b) => new Date(b.at).getTime() - new Date(a.at).getTime()
  );
  const unplayed = sortedMessages.filter((m) => m.playedAt === null);
  const lastFive = sortedMessages.slice(0, 5);
  const seenIds = new Set<string>();
  const combinedMessages: FamilyMessage[] = [];
  for (const m of [...unplayed, ...lastFive]) {
    if (!seenIds.has(m.id)) {
      seenIds.add(m.id);
      combinedMessages.push(m);
    }
  }
  combinedMessages.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

  return {
    settings: { ...state.settings },
    medications: state.medications.map((m) => ({ ...m })),
    doses: todayDoses.map((d) => ({ ...d })),
    checkins: recentCheckins,
    alerts: recentAlerts.map((a) => ({ ...a })),
    messages: combinedMessages.map((m) => ({ ...m })),
  };
}

export function normalizeMood(value: string | undefined): MoodLevel {
  if (value === 'good' || value === 'okay' || value === 'low' || value === 'unclear') {
    return value;
  }
  return 'unclear';
}

export function normalizeSeverity(value: string | undefined): SeverityLevel {
  if (value === 'low' || value === 'medium' || value === 'high' || value === 'urgent') {
    return value;
  }
  return 'medium';
}

export function applyCheckInSafetyNet(
  transcript: string,
  rawAnalysis: Partial<CheckInAIOutput> | null,
  confirmedMedications: Medication[],
  seniorName: string,
  caregiverName: string
): CheckInAIOutput {
  const matchedUrgentRegex = URGENT_SAFETY_REGEX.test(transcript);
  const matchedSelfHarm = SELF_HARM_REGEX.test(transcript);

  const confirmedByLower = new Map<string, string>();
  for (const med of confirmedMedications) {
    if (med.status === 'confirmed') {
      confirmedByLower.set(med.name.trim().toLowerCase(), med.name);
    }
  }

  const rawConcerns = Array.isArray(rawAnalysis?.concerns) ? rawAnalysis.concerns : [];
  const sanitizedConcerns: CheckInConcern[] = rawConcerns
    .filter((c) => c && typeof c.text === 'string' && c.text.trim().length > 0)
    .map((c) => {
      let matchedMed: string | null = null;
      if (typeof c.possibleMedication === 'string' && c.possibleMedication.trim()) {
        const candidate = c.possibleMedication.trim().toLowerCase();
        if (confirmedByLower.has(candidate)) {
          matchedMed = confirmedByLower.get(candidate) || null;
        } else {
          for (const [lowerName, canonicalName] of confirmedByLower.entries()) {
            if (candidate.includes(lowerName) || lowerName.includes(candidate)) {
              matchedMed = canonicalName;
              break;
            }
          }
        }
      }
      return {
        text: c.text.trim(),
        severity: normalizeSeverity(c.severity),
        possibleMedication: matchedMed,
      };
    });

  let isUrgent =
    Boolean(rawAnalysis?.urgent) ||
    matchedUrgentRegex ||
    sanitizedConcerns.some((c) => c.severity === 'urgent');

  if (matchedUrgentRegex && !sanitizedConcerns.some((c) => c.severity === 'urgent')) {
    sanitizedConcerns.unshift({
      text: matchedSelfHarm
        ? `${seniorName} expressed distress or thoughts of self-harm during her check-in.`
        : `${seniorName} mentioned an urgent safety symptom ("${transcript.trim().slice(0, 100)}").`,
      severity: 'urgent',
      possibleMedication: null,
    });
    isUrgent = true;
  }

  let replyToSenior =
    typeof rawAnalysis?.replyToSenior === 'string' && rawAnalysis.replyToSenior.trim().length > 0
      ? rawAnalysis.replyToSenior.trim()
      : `Thank you for checking in, ${seniorName}. I've shared a note with ${caregiverName}.`;

  if (isUrgent) {
    const mentions911 = /911/.test(replyToSenior);
    if (!mentions911 || !rawAnalysis) {
      replyToSenior = `I've alerted ${caregiverName} right away. Please call 911 now if this is an emergency.`;
    }
    if (matchedSelfHarm && !/988/.test(replyToSenior)) {
      replyToSenior += ' You can also call or text 988 anytime to talk with someone who cares.';
    }
  }

  const summary =
    typeof rawAnalysis?.summary === 'string' && rawAnalysis.summary.trim().length > 0
      ? rawAnalysis.summary.trim()
      : isUrgent
        ? `${seniorName} reported an urgent safety concern during her daily check-in and needs immediate attention.`
        : `${seniorName} completed her daily check-in.`;

  const suggestedOpener =
    typeof rawAnalysis?.suggestedOpener === 'string' && rawAnalysis.suggestedOpener.trim().length > 0
      ? rawAnalysis.suggestedOpener.trim()
      : isUrgent
        ? `Hi ${seniorName}, I just got your alert — are you safe right now, and do you need me to call 911?`
        : `Hi ${seniorName}, just thinking of you — how is your day going so far?`;

  const goodMoments = Array.isArray(rawAnalysis?.goodMoments)
    ? rawAnalysis.goodMoments
        .filter((g): g is string => typeof g === 'string' && g.trim().length > 0)
        .map((g) => g.trim())
    : [];

  return {
    summary,
    mood: isUrgent && !rawAnalysis?.mood ? 'low' : normalizeMood(rawAnalysis?.mood),
    concerns: sanitizedConcerns,
    goodMoments,
    suggestedOpener,
    replyToSenior,
    urgent: isUrgent,
  };
}

export function ensureTodayDosesForMedication(
  state: AppState,
  med: Medication,
  now: Date = new Date(),
  protectedPastDoseIds?: Set<string>
): DoseEvent[] {
  if (med.status !== 'confirmed') return [];
  const tz = state.settings.tzOffsetMinutes;

  const existingForMedToday = state.doses.filter(
    (d) => d.medicationId === med.id && isSameLocalDay(d.scheduledFor, now, tz)
  );
  if (existingForMedToday.length >= med.times.length) {
    return [];
  }

  const created: DoseEvent[] = [];

  for (const hhmm of med.times) {
    const scheduledIso = buildScheduledIso(now, hhmm, tz);
    const targetHm = getLocalHourMinute(scheduledIso, tz);
    const alreadyExists = existingForMedToday.some((d) => {
      const hm = getLocalHourMinute(d.scheduledFor, tz);
      return hm.hours === targetHm.hours && hm.minutes === targetHm.minutes;
    });

    if (!alreadyExists) {
      const newDose: DoseEvent = {
        id: makeId('dose'),
        medicationId: med.id,
        scheduledFor: scheduledIso,
        status: 'pending',
        remindedAt: null,
        takenAt: null,
      };
      state.doses.push(newDose);
      created.push(newDose);

      const graceMs = Math.max(1, state.settings.doseGraceMinutes) * 60 * 1000;
      if (
        protectedPastDoseIds &&
        new Date(scheduledIso).getTime() + graceMs < now.getTime()
      ) {
        protectedPastDoseIds.add(newDose.id);
      }
    }
  }
  return created;
}

export function confirmMedicationInState(
  state: AppState,
  medId: string,
  updates: Partial<Medication>,
  now: Date = new Date(),
  protectedPastDoseIds?: Set<string>
): { medication: Medication; createdAlerts: Alert[] } | null {
  const med = state.medications.find((m) => m.id === medId);
  if (!med) return null;

  const wasDraft = med.status === 'draft';
  const timesUpdated = Array.isArray(updates.times) && updates.times.length > 0;

  if (typeof updates.name === 'string') med.name = updates.name.trim() || med.name;
  if (typeof updates.strength === 'string') med.strength = updates.strength.trim();
  if (typeof updates.dose === 'string') med.dose = updates.dose.trim();
  if (typeof updates.instructions === 'string') med.instructions = updates.instructions.trim();
  if (timesUpdated) {
    med.times = updates.times!.map((t) => t.trim()).filter(Boolean);
    // Replace pending doses for today so edited schedule times take effect immediately
    const tz = state.settings.tzOffsetMinutes;
    state.doses = state.doses.filter(
      (d) =>
        !(
          d.medicationId === med.id &&
          d.status === 'pending' &&
          isSameLocalDay(d.scheduledFor, now, tz)
        )
    );
  }
  if (updates.withFood === true || updates.withFood === false || updates.withFood === null) {
    med.withFood = updates.withFood;
  }
  if (updates.purpose === null || typeof updates.purpose === 'string') {
    med.purpose = updates.purpose ? updates.purpose.trim() : null;
  }
  if (typeof updates.startedOn === 'string' && updates.startedOn.trim()) {
    med.startedOn = updates.startedOn.trim();
  }
  if (Array.isArray(updates.pharmacistQuestions)) {
    med.pharmacistQuestions = updates.pharmacistQuestions.map((q) => q.trim()).filter(Boolean);
  }
  if (updates.pillPhotoDataUrl === null || typeof updates.pillPhotoDataUrl === 'string') {
    med.pillPhotoDataUrl = updates.pillPhotoDataUrl ? updates.pillPhotoDataUrl.trim() : null;
  }

  med.status = 'confirmed';
  med.unreadableFields = [];
  med.confidence = 'high';

  ensureTodayDosesForMedication(state, med, now, protectedPastDoseIds);

  const createdAlerts: Alert[] = [];
  if (wasDraft && med.pharmacistQuestions.length > 0) {
    const alert: Alert = {
      id: makeId('alert'),
      at: now.toISOString(),
      type: 'pharmacist_question',
      severity: 'low',
      title: `Pharmacist note for ${med.name}`,
      body: med.pharmacistQuestions.join(' · '),
      suggestedOpener: `Hi ${state.settings.seniorName}, next time we speak with the pharmacist, let's check in on ${med.name} together.`,
      acknowledged: false,
    };
    state.alerts.unshift(alert);
    createdAlerts.push(alert);
  }

  return { medication: med, createdAlerts };
}

function formatScheduledTimeForTz(isoString: string, tzOffsetMinutes?: number): string {
  const { hours, minutes } = getLocalHourMinute(isoString, tzOffsetMinutes);
  const period = hours >= 12 ? 'PM' : 'AM';
  const h12 = hours % 12 || 12;
  return `${h12}:${String(minutes).padStart(2, '0')} ${period}`;
}

export function runSchedulerTick(
  state: AppState,
  now: Date = new Date(),
  protectedPastDoseIds?: Set<string>
): { changed: boolean; newHighOrUrgentAlerts: Alert[] } {
  let changed = false;
  const newHighOrUrgentAlerts: Alert[] = [];
  const tz = state.settings.tzOffsetMinutes;

  for (const med of state.medications) {
    if (med.status === 'confirmed') {
      const added = ensureTodayDosesForMedication(state, med, now, undefined);
      if (added.length > 0) changed = true;
    }
  }

  const graceMs = Math.max(1, state.settings.doseGraceMinutes) * 60 * 1000;

  for (const dose of state.doses) {
    if (dose.status !== 'pending') continue;
    if (!isSameLocalDay(dose.scheduledFor, now, tz)) continue;
    if (protectedPastDoseIds?.has(dose.id)) continue;

    const scheduledMs = new Date(dose.scheduledFor).getTime();
    const elapsedMs = now.getTime() - scheduledMs;

    if (elapsedMs >= 0 && dose.remindedAt === null) {
      dose.remindedAt = now.toISOString();
      changed = true;
    }

    if (elapsedMs > graceMs) {
      dose.status = 'missed';
      changed = true;

      const missedTodayCount = state.doses.filter(
        (d) => isSameLocalDay(d.scheduledFor, now, tz) && d.status === 'missed'
      ).length;

      const med = state.medications.find((m) => m.id === dose.medicationId);
      const medName = med ? `${med.name}${med.strength ? ` (${med.strength})` : ''}` : 'medication';
      const bucket = formatTimeOfDayBucket(dose.scheduledFor, tz);
      const severity: SeverityLevel = missedTodayCount >= 2 ? 'high' : 'medium';

      const alert: Alert = {
        id: makeId('alert'),
        at: now.toISOString(),
        type: 'missed_dose',
        severity,
        title:
          missedTodayCount >= 2
            ? `${state.settings.seniorName} missed a second dose today (${med?.name || 'pill'})`
            : `Missed ${bucket} dose: ${medName}`,
        body: `${medName} scheduled for ${formatScheduledTimeForTz(
          dose.scheduledFor,
          tz
        )} has not been marked taken.`,
        suggestedOpener: `Hi ${state.settings.seniorName === 'Margaret' ? 'Mom' : state.settings.seniorName}, just checking in — did you get a chance to take your ${bucket} ${med?.name || 'pill'}?`,
        acknowledged: false,
      };
      state.alerts.unshift(alert);
      if (severity === 'high') {
        newHighOrUrgentAlerts.push(alert);
      }
    }
  }

  if (state.settings.lastContactAt) {
    const lastContactMs = new Date(state.settings.lastContactAt).getTime();
    const diffDays = Math.floor((now.getTime() - lastContactMs) / (24 * 60 * 60 * 1000));

    if (diffDays >= state.settings.noContactNudgeDays) {
      const existingNudge = state.alerts.find(
        (a) =>
          a.type === 'no_contact' &&
          (!a.acknowledged || new Date(a.at).getTime() > lastContactMs)
      );

      if (!existingNudge) {
        const sortedCheckins = [...state.checkins].sort(
          (a, b) => new Date(b.at).getTime() - new Date(a.at).getTime()
        );
        let latestMoment: string | null = null;
        for (const c of sortedCheckins) {
          if (c.goodMoments.length > 0) {
            latestMoment = c.goodMoments[0];
            break;
          }
        }

        const warmDetail = latestMoment
          ? ` She mentioned: "${latestMoment.replace(/\.$/, '')}."`
          : '';
        const openerDetail = latestMoment
          ? `Hi ${state.settings.seniorName === 'Margaret' ? 'Mom' : state.settings.seniorName}! I was thinking about you — tell me more about "${latestMoment.replace(/\.$/, '').toLowerCase()}"!`
          : `Hi ${state.settings.seniorName === 'Margaret' ? 'Mom' : state.settings.seniorName}! It's been a few days and I wanted to hear your voice — how has your week been?`;

        const nudgeAlert: Alert = {
          id: makeId('alert'),
          at: now.toISOString(),
          type: 'no_contact',
          severity: 'low',
          title: `Time to catch up with ${state.settings.seniorName}`,
          body: `You haven't called ${state.settings.seniorName} in ${diffDays} days.${warmDetail}`,
          suggestedOpener: openerDetail,
          acknowledged: false,
        };
        state.alerts.unshift(nudgeAlert);
        changed = true;
      }
    }
  }

  return { changed, newHighOrUrgentAlerts };
}

export function forceNextDoseDueNow(
  state: AppState,
  now: Date = new Date(),
  protectedPastDoseIds?: Set<string>
): DoseEvent | null {
  const tz = state.settings.tzOffsetMinutes;
  const pendingToday = state.doses
    .filter((d) => d.status === 'pending' && isSameLocalDay(d.scheduledFor, now, tz))
    .sort((a, b) => new Date(a.scheduledFor).getTime() - new Date(b.scheduledFor).getTime());

  const target = pendingToday[0] || null;
  if (target) {
    protectedPastDoseIds?.delete(target.id);
    target.scheduledFor = now.toISOString();
    target.remindedAt = now.toISOString();
    return target;
  }

  const firstConfirmed = state.medications.find((m) => m.status === 'confirmed');
  if (!firstConfirmed) return null;

  const extraDose: DoseEvent = {
    id: makeId('dose'),
    medicationId: firstConfirmed.id,
    scheduledFor: now.toISOString(),
    status: 'pending',
    remindedAt: now.toISOString(),
    takenAt: null,
  };
  state.doses.push(extraDose);
  return extraDose;
}

export function forceMissNextDose(
  state: AppState,
  now: Date = new Date(),
  protectedPastDoseIds?: Set<string>
): { missedDose: DoseEvent | null; newHighOrUrgentAlerts: Alert[] } {
  const tz = state.settings.tzOffsetMinutes;
  const pendingToday = state.doses
    .filter((d) => d.status === 'pending' && isSameLocalDay(d.scheduledFor, now, tz))
    .sort((a, b) => new Date(a.scheduledFor).getTime() - new Date(b.scheduledFor).getTime());

  const target = pendingToday[0] || null;
  if (!target) {
    return { missedDose: null, newHighOrUrgentAlerts: [] };
  }

  protectedPastDoseIds?.delete(target.id);
  const backdatedMs = now.getTime() - (state.settings.doseGraceMinutes + 5) * 60 * 1000;
  target.scheduledFor = new Date(backdatedMs).toISOString();

  const { newHighOrUrgentAlerts } = runSchedulerTick(state, now, protectedPastDoseIds);
  return { missedDose: target, newHighOrUrgentAlerts };
}

export function forceSixDaysNoContact(
  state: AppState,
  now: Date = new Date(),
  protectedPastDoseIds?: Set<string>
): void {
  const sixDaysAgo = new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000);
  state.settings.lastContactAt = sixDaysAgo.toISOString();
  state.alerts = state.alerts.filter((a) => a.type !== 'no_contact');
  runSchedulerTick(state, now, protectedPastDoseIds);
}

export function ensureWavAudioBytes(rawBytes: Uint8Array, sampleRate = 24000): Uint8Array {
  const hasRiffWaveHeader =
    rawBytes.byteLength >= 44 &&
    rawBytes[0] === 0x52 && // 'R'
    rawBytes[1] === 0x49 && // 'I'
    rawBytes[2] === 0x46 && // 'F'
    rawBytes[3] === 0x46 && // 'F'
    rawBytes[8] === 0x57 && // 'W'
    rawBytes[9] === 0x41 && // 'A'
    rawBytes[10] === 0x56 && // 'V'
    rawBytes[11] === 0x45; // 'E'

  if (hasRiffWaveHeader) {
    return rawBytes;
  }

  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = rawBytes.byteLength;
  const out = new Uint8Array(44 + dataSize);
  const view = new DataView(out.buffer);

  // "RIFF"
  out.set([0x52, 0x49, 0x46, 0x46], 0);
  view.setUint32(4, 36 + dataSize, true);
  // "WAVE"
  out.set([0x57, 0x41, 0x56, 0x45], 8);
  // "fmt "
  out.set([0x66, 0x6d, 0x74, 0x20], 12);
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // Linear PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  // "data"
  out.set([0x64, 0x61, 0x74, 0x61], 36);
  view.setUint32(40, dataSize, true);
  out.set(rawBytes, 44);

  return out;
}

export function scoreSpeechSynthesisVoice(voice: {
  name: string;
  lang: string;
  localService?: boolean;
}): number {
  const lang = (voice.lang || '').toLowerCase();
  if (!lang.startsWith('en')) {
    return -100;
  }

  const name = (voice.name || '').toLowerCase();
  let score = 10;

  if (lang === 'en-us') score += 15;
  else if (lang === 'en-gb' || lang === 'en-au' || lang === 'en-ca') score += 10;

  // Strongly prefer neural / natural / enhanced voices over flat robotic synthesizers
  if (/\b(natural|neural|premium|enhanced|siri)\b/.test(name)) score += 45;
  if (/\b(ava|samantha|allison|nicky|zoe|serena|karen|moira|tessa|jenny|aria|sonia)\b/.test(name)) {
    score += 30;
  }
  if (name.includes('google us english') || name.includes('google uk english female')) {
    score += 28;
  }

  // Penalize robotic, novelty, or low-quality fallback voices
  if (
    /\b(espeak|compact|zarvox|trinoids|whisper|albert|bad news|bahh|bells|boing|bubbles|cellos|deranged|good news|hysterical|organ|superstar| Wobble|fred|ralph|junior|kathy)\b/i.test(
      name
    )
  ) {
    score -= 80;
  }

  return score;
}
