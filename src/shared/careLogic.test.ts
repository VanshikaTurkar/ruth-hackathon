import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyCheckInSafetyNet,
  buildPublicState,
  buildScheduledIso,
  confirmMedicationInState,
  createSeedState,
  daysSinceDate,
  ensureWavAudioBytes,
  forceMissNextDose,
  forceNextDoseDueNow,
  forceSixDaysNoContact,
  isDoseInReminderWindow,
  isSameLocalDay,
  resolveGeminiModelName,
  runSchedulerTick,
  scoreSpeechSynthesisVoice,
  shouldShowPillImageForSenior,
  syncTimezoneOffset,
} from './careLogic.ts';
import type { DoseEvent, Medication } from './types.ts';

test('seed state sets Lisinopril as next pending pill and Metformin 08:00 as taken', () => {
  const now = new Date('2026-11-13T13:20:00');
  const protectedIds = new Set<string>();
  const state = createSeedState(now, protectedIds);

  assert.equal(state.settings.seniorName, 'Margaret');
  assert.equal(state.settings.caregiverName, 'Priya');
  assert.equal(state.medications.length, 3);

  const lisinopril = state.medications.find((m) => m.name === 'Lisinopril');
  assert.ok(lisinopril);
  assert.equal(daysSinceDate(lisinopril.startedOn, now), 3);

  const pendingDoses = state.doses.filter((d) => d.status === 'pending');
  assert.equal(pendingDoses.length, 3);
  assert.equal(pendingDoses[0].medicationId, lisinopril.id);

  runSchedulerTick(state, now, protectedIds);
  assert.equal(pendingDoses[0].status, 'pending');
});

test('isDoseInReminderWindow only shows reminder right before (<=15m) or when due', () => {
  const scheduled = new Date('2026-11-13T20:00:00Z');
  const dose: DoseEvent = {
    id: 'dose_pm',
    medicationId: 'med_metformin',
    scheduledFor: scheduled.toISOString(),
    status: 'pending',
    remindedAt: null,
    takenAt: null,
  };

  // 2 hours early -> hidden
  assert.equal(isDoseInReminderWindow(dose, new Date('2026-11-13T18:00:00Z'), 30, 15), false);

  // 16 minutes early -> hidden
  assert.equal(isDoseInReminderWindow(dose, new Date('2026-11-13T19:44:00Z'), 30, 15), false);

  // 15 minutes early (right before!) -> shown
  assert.equal(isDoseInReminderWindow(dose, new Date('2026-11-13T19:45:00Z'), 30, 15), true);

  // Exact scheduled time -> shown
  assert.equal(isDoseInReminderWindow(dose, new Date('2026-11-13T20:00:00Z'), 30, 15), true);

  // Past grace period without remindedAt (un-reminded old seed dose) -> hidden
  assert.equal(isDoseInReminderWindow(dose, new Date('2026-11-13T22:00:00Z'), 30, 15), false);

  // Explicitly reminded (e.g. Simulate pill due now) -> shown
  dose.remindedAt = '2026-11-13T20:00:00Z';
  assert.equal(isDoseInReminderWindow(dose, new Date('2026-11-13T20:10:00Z'), 30, 15), true);

  // Taken -> hidden
  dose.status = 'taken';
  assert.equal(isDoseInReminderWindow(dose, new Date('2026-11-13T20:10:00Z'), 30, 15), false);
});

test('timezone-aware scheduling aligns 20:00 PST properly on a UTC clock and forceNextDoseDueNow activates reminder', () => {
  // 2:10 PM PST = 22:10 UTC (tzOffsetMinutes = 480)
  const nowUtc = new Date('2026-11-13T22:10:00.000Z');
  const pstOffset = 480;
  const iso8pmPst = buildScheduledIso(nowUtc, '20:00', pstOffset);

  assert.equal(iso8pmPst, '2026-11-14T04:00:00.000Z');
  assert.equal(isSameLocalDay(iso8pmPst, nowUtc, pstOffset), true);

  const protectedIds = new Set<string>();
  // Start in UTC (0), then sync to PST (480)
  const state = createSeedState(nowUtc, protectedIds, 0);
  const changed = syncTimezoneOffset(state, pstOffset, nowUtc, protectedIds);
  assert.equal(changed, true);

  // Taken morning dose remains taken without duplicates
  const takenMorning = state.doses.filter((d) => d.status === 'taken');
  assert.equal(takenMorning.length, 1);

  // Evening Metformin is now scheduled for 8:00 PM PST (2026-11-14T04:00:00.000Z) and NOT in reminder window at 2:10 PM PST
  const pmDose = state.doses.find((d) => d.id === 'dose_metformin_pm');
  assert.ok(pmDose);
  assert.equal(pmDose.scheduledFor, '2026-11-14T04:00:00.000Z');
  assert.equal(isDoseInReminderWindow(pmDose, nowUtc, 30, 15), false);

  const dueDose = forceNextDoseDueNow(state, nowUtc, protectedIds);
  assert.ok(dueDose);
  assert.equal(isDoseInReminderWindow(dueDose, nowUtc, 30, 15), true);
});

test('privacy filter strips transcript for caregiver when keptPrivate or shareCheckinWords=false', () => {
  const now = new Date('2026-11-13T13:20:00');
  const state = createSeedState(now);

  state.checkins.unshift({
    id: 'checkin_private',
    at: now.toISOString(),
    transcript: 'Private words about baked cookies and feeling a bit dizzy.',
    keptPrivate: true,
    summary: 'Margaret felt a little dizzy but enjoyed baking cookies.',
    mood: 'okay',
    concerns: [{ text: 'Mild dizziness since yesterday', severity: 'medium', possibleMedication: 'Lisinopril' }],
    goodMoments: ['Baked cookies with granddaughter'],
    suggestedOpener: 'Hi Mom! Heard you baked cookies today.',
    urgent: false,
  });

  const caregiverView = buildPublicState(state, 'caregiver', now);
  const privateCheckinInCaregiver = caregiverView.checkins.find((c) => c.id === 'checkin_private');
  assert.ok(privateCheckinInCaregiver);
  assert.equal('transcript' in privateCheckinInCaregiver, false);

  const seniorView = buildPublicState(state, 'senior', now);
  const privateCheckinInSenior = seniorView.checkins.find((c) => c.id === 'checkin_private');
  assert.equal(
    privateCheckinInSenior?.transcript,
    'Private words about baked cookies and feeling a bit dizzy.'
  );

  state.settings.shareCheckinWords = false;
  const caregiverAllPrivate = buildPublicState(state, 'caregiver', now);
  for (const c of caregiverAllPrivate.checkins) {
    assert.equal('transcript' in c, false);
  }
});

test('safety net forces urgent=true even when AI fails and validates possibleMedication', () => {
  const now = new Date('2026-11-13T13:20:00');
  const state = createSeedState(now);

  const fallbackResult = applyCheckInSafetyNet(
    "I fell and can't get up in the hallway",
    null,
    state.medications,
    'Margaret',
    'Priya'
  );
  assert.equal(fallbackResult.urgent, true);
  assert.ok(fallbackResult.concerns.some((c) => c.severity === 'urgent'));
  assert.match(fallbackResult.replyToSenior, /911/);

  const selfHarmResult = applyCheckInSafetyNet(
    'Sometimes I just want to die',
    null,
    state.medications,
    'Margaret',
    'Priya'
  );
  assert.equal(selfHarmResult.urgent, true);
  assert.match(selfHarmResult.replyToSenior, /988/);

  const medCheckResult = applyCheckInSafetyNet(
    'Feeling dizzy today',
    {
      summary: 'Margaret felt dizzy.',
      mood: 'okay',
      concerns: [
        { text: 'Dizziness', severity: 'medium', possibleMedication: 'lisinopril' },
        { text: 'Dry mouth', severity: 'low', possibleMedication: 'FakeDrug9000' },
      ],
      goodMoments: [],
      suggestedOpener: 'Hi Mom, how are you feeling?',
      replyToSenior: 'Thanks for telling me.',
      urgent: false,
    },
    state.medications,
    'Margaret',
    'Priya'
  );
  assert.equal(medCheckResult.concerns[0].possibleMedication, 'Lisinopril');
  assert.equal(medCheckResult.concerns[1].possibleMedication, null);
});

test('forceMissNextDose and second missed dose escalate severity from medium to high', () => {
  const now = new Date('2026-11-13T13:20:00');
  const protectedIds = new Set<string>();
  const state = createSeedState(now, protectedIds);

  const firstMiss = forceMissNextDose(state, now, protectedIds);
  assert.ok(firstMiss.missedDose);
  assert.equal(firstMiss.missedDose.status, 'missed');
  assert.equal(state.alerts.length, 1);
  assert.equal(state.alerts[0].type, 'missed_dose');
  assert.equal(state.alerts[0].severity, 'medium');

  const secondMiss = forceMissNextDose(state, now, protectedIds);
  assert.ok(secondMiss.missedDose);
  assert.equal(state.alerts[0].severity, 'high');
  assert.equal(secondMiss.newHighOrUrgentAlerts.length, 1);
});

test('confirmMedicationInState generates doses and pharmacist_question alert', () => {
  const now = new Date('2026-11-13T13:20:00');
  const protectedIds = new Set<string>();
  const state = createSeedState(now, protectedIds);

  const draft: Medication = {
    id: 'med_draft_amlodipine',
    name: 'Amlodipine',
    strength: '5 mg',
    dose: '1 tablet',
    instructions: 'Take one tablet by mouth once daily',
    times: ['08:00'],
    withFood: null,
    purpose: 'for blood pressure',
    startedOn: '2026-11-13',
    status: 'draft',
    confidence: 'high',
    unreadableFields: [],
    pharmacistQuestions: [
      'Ask your pharmacist about taking Amlodipine alongside Lisinopril for blood pressure.',
    ],
  };
  state.medications.push(draft);

  const result = confirmMedicationInState(state, draft.id, {}, now, protectedIds);
  assert.ok(result);
  assert.equal(result.medication.status, 'confirmed');
  assert.equal(result.createdAlerts.length, 1);
  assert.equal(result.createdAlerts[0].type, 'pharmacist_question');

  const amlodipineDoses = state.doses.filter((d) => d.medicationId === draft.id);
  assert.equal(amlodipineDoses.length, 1);
});

test('forceSixDaysNoContact creates one warm nudge with goodMoments detail and avoids duplicates', () => {
  const now = new Date('2026-11-13T13:20:00');
  const protectedIds = new Set<string>();
  const state = createSeedState(now, protectedIds);

  forceSixDaysNoContact(state, now, protectedIds);
  const nudges = state.alerts.filter((a) => a.type === 'no_contact');
  assert.equal(nudges.length, 1);
  assert.match(nudges[0].body, /6 days/);
  assert.match(nudges[0].body, /tomatoes/i);

  runSchedulerTick(state, now, protectedIds);
  const nudgesAfter = state.alerts.filter((a) => a.type === 'no_contact');
  assert.equal(nudgesAfter.length, 1);
});

test('resolveGeminiModelName sanitizes valid models and rejects malformed or non-Gemini strings', () => {
  assert.equal(resolveGeminiModelName(undefined), 'gemini-4-hydrogen');
  assert.equal(resolveGeminiModelName(''), 'gemini-4-hydrogen');
  assert.equal(resolveGeminiModelName('"models/gemini-3.1-flash-lite"'), 'gemini-3.1-flash-lite');
  assert.equal(resolveGeminiModelName('gemini-4-hydrogen'), 'gemini-4-hydrogen');

  // Rejects accidentally pasted keys, Anthropic model names, deprecated 1.5/2.0 models, or URLs
  assert.equal(resolveGeminiModelName('AIzaSyExampleInvalidModelString1234567890123456789012'), 'gemini-4-hydrogen');
  assert.equal(resolveGeminiModelName('claude-sonnet-4-5-20250929'), 'gemini-4-hydrogen');
  assert.equal(resolveGeminiModelName('gemini-1.5-flash'), 'gemini-4-hydrogen');
  assert.equal(resolveGeminiModelName('https://generativelanguage.googleapis.com'), 'gemini-4-hydrogen');
});

test('ensureWavAudioBytes preserves RIFF/WAVE buffers and wraps raw PCM cleanly', () => {
  const rawPcm = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
  const wrapped = ensureWavAudioBytes(rawPcm, 24000);
  assert.equal(wrapped.byteLength, 48);
  assert.equal(String.fromCharCode(wrapped[0], wrapped[1], wrapped[2], wrapped[3]), 'RIFF');
  assert.equal(String.fromCharCode(wrapped[8], wrapped[9], wrapped[10], wrapped[11]), 'WAVE');

  // Passing an already-valid WAV buffer does not double-wrap
  const secondPass = ensureWavAudioBytes(wrapped, 24000);
  assert.equal(secondPass.byteLength, 48);
  assert.equal(secondPass, wrapped);
});

test('scoreSpeechSynthesisVoice prefers enhanced/natural English voices over robotic ones', () => {
  const enhancedAva = scoreSpeechSynthesisVoice({ name: 'Ava (Enhanced)', lang: 'en-US' });
  const googleUs = scoreSpeechSynthesisVoice({ name: 'Google US English', lang: 'en-US' });
  const roboticFred = scoreSpeechSynthesisVoice({ name: 'Fred', lang: 'en-US' });
  const frenchVoice = scoreSpeechSynthesisVoice({ name: 'Thomas', lang: 'fr-FR' });

  assert.ok(enhancedAva > googleUs);
  assert.ok(googleUs > roboticFred);
  assert.ok(frenchVoice < 0);
});

test('shouldShowPillImageForSenior only shows pill photo when dose needs to be taken and confirmMedicationInState saves pillPhotoDataUrl', () => {
  const scheduled = new Date('2026-11-13T20:00:00Z');
  const dose: DoseEvent = {
    id: 'dose_pill_vis',
    medicationId: 'med_metformin',
    scheduledFor: scheduled.toISOString(),
    status: 'pending',
    remindedAt: null,
    takenAt: null,
  };

  // Hours before scheduled time (Upcoming) -> hidden for Margaret
  assert.equal(shouldShowPillImageForSenior(dose, new Date('2026-11-13T16:00:00Z'), 30, 15), false);

  // Inside active reminder window (Due soon / Due now) -> shown for Margaret
  assert.equal(shouldShowPillImageForSenior(dose, new Date('2026-11-13T19:50:00Z'), 30, 15), true);
  assert.equal(shouldShowPillImageForSenior(dose, new Date('2026-11-13T20:05:00Z'), 30, 15), true);

  // Missed dose (needs action) -> shown for Margaret
  dose.status = 'missed';
  assert.equal(shouldShowPillImageForSenior(dose, new Date('2026-11-13T21:00:00Z'), 30, 15), true);

  // Taken dose -> hidden for Margaret
  dose.status = 'taken';
  assert.equal(shouldShowPillImageForSenior(dose, new Date('2026-11-13T20:05:00Z'), 30, 15), false);

  // Confirming or updating medication persists pillPhotoDataUrl
  const state = createSeedState(new Date('2026-11-13T13:20:00Z'));
  const updated = confirmMedicationInState(
    state,
    'med_metformin',
    { pillPhotoDataUrl: 'data:image/jpeg;base64,PILL123' },
    new Date('2026-11-13T13:20:00Z')
  );
  assert.ok(updated);
  assert.equal(updated.medication.pillPhotoDataUrl, 'data:image/jpeg;base64,PILL123');
});


