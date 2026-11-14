import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyCheckInSafetyNet,
  buildPublicState,
  confirmMedicationInState,
  createSeedState,
  forceMissNextDose,
  forceNextDoseDueNow,
  forceSixDaysNoContact,
  makeId,
  runSchedulerTick,
  syncTimezoneOffset,
  toLocalDateKey,
  URGENT_SAFETY_REGEX,
} from './src/shared/careLogic.ts';
import type { Alert, AppState, CheckIn, FamilyMessage, Medication } from './src/shared/types.ts';
import {
  analyzeCheckInTranscript,
  analyzeMedicationLabel,
  synthesizeWarmSpeechWav,
} from './server/ai.ts';
import { sendOptionalAlertSms } from './server/sms.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_FILE = path.join(__dirname, 'data.json');
const PORT = 3000;

const protectedPastDoseIds = new Set<string>();

function saveState(currentState: AppState): void {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(currentState, null, 2), 'utf-8');
  } catch (err) {
    console.error('Failed to persist data.json:', err);
  }
}

function loadInitialState(): AppState {
  if (fs.existsSync(DATA_FILE)) {
    try {
      const raw = fs.readFileSync(DATA_FILE, 'utf-8');
      const parsed = JSON.parse(raw) as AppState;
      if (parsed && parsed.settings && Array.isArray(parsed.medications)) {
        const now = new Date();
        for (const d of parsed.doses || []) {
          if (d.status === 'pending' && new Date(d.scheduledFor).getTime() <= now.getTime()) {
            protectedPastDoseIds.add(d.id);
          }
        }
        return parsed;
      }
    } catch (err) {
      console.warn('Could not parse existing data.json, seeding fresh state:', err);
    }
  }
  const seeded = createSeedState(new Date(), protectedPastDoseIds);
  saveState(seeded);
  return seeded;
}

let state: AppState = loadInitialState();

async function executeScheduler(): Promise<void> {
  const { changed, newHighOrUrgentAlerts } = runSchedulerTick(
    state,
    new Date(),
    protectedPastDoseIds
  );
  if (changed) {
    saveState(state);
  }
  for (const alert of newHighOrUrgentAlerts) {
    await sendOptionalAlertSms(alert, state.settings.caregiverPhone);
  }
}

async function startServer() {
  const app = express();

  app.use(express.json({ limit: '10mb' }));
  app.use('/demo-assets', express.static(path.join(__dirname, 'demo-assets')));

  // GET /api/state?view=senior|caregiver&tzOffset=...
  app.get('/api/state', (req, res) => {
    const view = req.query.view === 'caregiver' ? 'caregiver' : 'senior';
    const rawTz = req.query.tzOffset;
    const now = new Date();
    if (typeof rawTz === 'string' && rawTz.trim() !== '') {
      const parsedTz = Number(rawTz);
      if (syncTimezoneOffset(state, parsedTz, now, protectedPastDoseIds)) {
        saveState(state);
      }
    }
    res.json(buildPublicState(state, view, now));
  });

  // POST /api/medications/scan
  app.post('/api/medications/scan', async (req, res) => {
    try {
      const { imageDataUrl, labelText, pillPhotoDataUrl } = req.body ?? {};
      if (
        (!imageDataUrl || typeof imageDataUrl !== 'string') &&
        (!labelText || typeof labelText !== 'string' || !labelText.trim())
      ) {
        res.status(400).json({
          error: 'Please provide a pill bottle photo or paste the printed label text.',
        });
        return;
      }

      const confirmedMedications = state.medications.filter((m) => m.status === 'confirmed');
      const scanOutput = await analyzeMedicationLabel({
        imageDataUrl: typeof imageDataUrl === 'string' ? imageDataUrl : undefined,
        labelText: typeof labelText === 'string' ? labelText : undefined,
        confirmedMedications,
      });

      const draftMedication: Medication = {
        id: makeId('med'),
        name: scanOutput.name,
        strength: scanOutput.strength,
        dose: scanOutput.dose,
        instructions: scanOutput.instructions,
        times: scanOutput.times,
        withFood: scanOutput.withFood,
        purpose: scanOutput.purpose,
        startedOn: toLocalDateKey(new Date(), state.settings.tzOffsetMinutes),
        status: 'draft',
        confidence: scanOutput.confidence,
        unreadableFields: scanOutput.unreadableFields,
        pharmacistQuestions: scanOutput.pharmacistQuestions,
        pillPhotoDataUrl:
          typeof pillPhotoDataUrl === 'string' && pillPhotoDataUrl.trim()
            ? pillPhotoDataUrl.trim()
            : null,
      };

      state.medications.push(draftMedication);
      saveState(state);
      res.json(draftMedication);
    } catch (err) {
      console.error('Medication scan failed:', err);
      const errText = err instanceof Error ? err.message : String(err);
      const isKeyIssue = /API_KEY_INVALID|PERMISSION_DENIED|insufficient authentication/i.test(
        errText
      );
      res.status(500).json({
        error: isKeyIssue
          ? 'Please check your GEMINI_API_KEY in the Settings > Secrets panel and try scanning again.'
          : "We couldn't clearly read that label right now. Please try pasting the label text or scanning again.",
      });
    }
  });

  // POST /api/medications/:id/confirm
  app.post('/api/medications/:id/confirm', (req, res) => {
    const { id } = req.params;
    const updates = req.body ?? {};
    if (typeof updates.name === 'string' && !updates.name.trim()) {
      res.status(400).json({ error: 'Medication name is required before confirming.' });
      return;
    }

    const existing = state.medications.find((m) => m.id === id);
    if (!existing) {
      res.status(404).json({ error: 'Medication draft not found.' });
      return;
    }
    if (!existing.name.trim() && (!updates.name || !String(updates.name).trim())) {
      res.status(400).json({ error: 'Please fill in the medication name before confirming.' });
      return;
    }

    const result = confirmMedicationInState(state, id, updates, new Date(), protectedPastDoseIds);
    if (!result) {
      res.status(404).json({ error: 'Medication not found.' });
      return;
    }

    saveState(state);
    res.json(result.medication);
  });

  // DELETE /api/medications/:id
  app.delete('/api/medications/:id', (req, res) => {
    const { id } = req.params;
    const idx = state.medications.findIndex((m) => m.id === id);
    if (idx === -1) {
      res.status(404).json({ error: 'Medication not found.' });
      return;
    }
    state.medications.splice(idx, 1);
    state.doses = state.doses.filter(
      (d) => !(d.medicationId === id && d.status === 'pending')
    );
    saveState(state);
    res.json({ ok: true });
  });

  // POST /api/doses/:id/taken
  app.post('/api/doses/:id/taken', (req, res) => {
    const { id } = req.params;
    const dose = state.doses.find((d) => d.id === id);
    if (!dose) {
      res.status(404).json({ error: 'Dose not found.' });
      return;
    }
    dose.status = 'taken';
    dose.takenAt = new Date().toISOString();
    protectedPastDoseIds.delete(dose.id);
    saveState(state);
    res.json(dose);
  });

  // POST /api/checkins
  app.post('/api/checkins', async (req, res) => {
    const { transcript, keptPrivate } = req.body ?? {};
    if (typeof transcript !== 'string' || !transcript.trim()) {
      res.status(400).json({ error: 'Please say or type a few words for your check-in first.' });
      return;
    }

    const cleanTranscript = transcript.trim();
    const isUrgentByRegex = URGENT_SAFETY_REGEX.test(cleanTranscript);
    const now = new Date();
    const confirmedMeds = state.medications.filter((m) => m.status === 'confirmed');
    const sortedRecent = [...state.checkins].sort(
      (a, b) => new Date(b.at).getTime() - new Date(a.at).getTime()
    );

    let aiRaw: Awaited<ReturnType<typeof analyzeCheckInTranscript>> | null = null;
    try {
      aiRaw = await analyzeCheckInTranscript({
        seniorName: state.settings.seniorName,
        transcript: cleanTranscript,
        confirmedMedications: confirmedMeds,
        recentCheckins: sortedRecent.slice(0, 3),
        todayIsoDate: toLocalDateKey(now, state.settings.tzOffsetMinutes),
      });
    } catch (err) {
      console.error('Check-in AI analysis error:', err);
      if (!isUrgentByRegex) {
        const errText = err instanceof Error ? err.message : String(err);
        const isKeyIssue = /API_KEY_INVALID|PERMISSION_DENIED|insufficient authentication/i.test(
          errText
        );
        res.status(500).json({
          error: isKeyIssue
            ? 'Please check your GEMINI_API_KEY in the Settings > Secrets panel and try sending again.'
            : "We couldn't process that check-in right now. Please try sending it once more, or tap 'I need help' if you need Priya immediately.",
        });
        return;
      }
      // When urgent regex matches, proceed with deterministic safety-net response even if AI failed!
    }

    const verified = applyCheckInSafetyNet(
      cleanTranscript,
      aiRaw,
      confirmedMeds,
      state.settings.seniorName,
      state.settings.caregiverName
    );

    const checkin: CheckIn = {
      id: makeId('checkin'),
      at: now.toISOString(),
      transcript: cleanTranscript,
      keptPrivate: Boolean(keptPrivate),
      summary: verified.summary,
      mood: verified.mood,
      concerns: verified.concerns,
      goodMoments: verified.goodMoments,
      suggestedOpener: verified.suggestedOpener,
      urgent: verified.urgent,
    };

    state.checkins.unshift(checkin);

    const createdAlerts: Alert[] = [];

    if (checkin.urgent) {
      const urgentConcernsText =
        checkin.concerns
          .filter((c) => c.severity === 'urgent')
          .map((c) => c.text)
          .join(' · ') || checkin.summary;

      const alert: Alert = {
        id: makeId('alert'),
        at: now.toISOString(),
        type: 'checkin_concern',
        severity: 'urgent',
        title: `Urgent check-in concern for ${state.settings.seniorName}`,
        body: urgentConcernsText,
        suggestedOpener: checkin.suggestedOpener,
        acknowledged: false,
      };
      state.alerts.unshift(alert);
      createdAlerts.push(alert);
    } else {
      const notableConcerns = checkin.concerns.filter(
        (c) => c.severity === 'medium' || c.severity === 'high'
      );
      for (const concern of notableConcerns) {
        const medLink = concern.possibleMedication
          ? ` (Possible link to ${concern.possibleMedication} — ask your pharmacist or doctor.)`
          : '';
        const alert: Alert = {
          id: makeId('alert'),
          at: now.toISOString(),
          type: 'checkin_concern',
          severity: concern.severity,
          title: `Check-in note for ${state.settings.seniorName}`,
          body: `${concern.text}${medLink}`,
          suggestedOpener: checkin.suggestedOpener,
          acknowledged: false,
        };
        state.alerts.unshift(alert);
        createdAlerts.push(alert);
      }
    }

    saveState(state);

    for (const alert of createdAlerts) {
      await sendOptionalAlertSms(alert, state.settings.caregiverPhone);
    }

    void synthesizeWarmSpeechWav(verified.replyToSenior).catch(() => {});

    res.json({
      checkin,
      replyToSenior: verified.replyToSenior,
    });
  });

  // POST /api/help
  app.post('/api/help', async (req, res) => {
    const now = new Date();
    const source = req.body?.source === 'urgent_checkin' ? 'urgent_checkin' : 'help_button';

    // Avoid creating duplicate help_button alert within 15 seconds if urgent check-in already triggered one
    const recentUrgent = state.alerts.find(
      (a) =>
        a.severity === 'urgent' &&
        !a.acknowledged &&
        now.getTime() - new Date(a.at).getTime() < 15_000 &&
        source === 'urgent_checkin'
    );

    if (recentUrgent) {
      res.json(recentUrgent);
      return;
    }

    const alert: Alert = {
      id: makeId('alert'),
      at: now.toISOString(),
      type: 'help_button',
      severity: 'urgent',
      title: `${state.settings.seniorName} pressed "I need help"`,
      body: `${state.settings.seniorName} requested immediate help from ${state.settings.caregiverName}. Call right away, or call 911 if this is a medical emergency.`,
      suggestedOpener: `Hi ${state.settings.seniorName === 'Margaret' ? 'Mom' : state.settings.seniorName}, I just got your help alert — I'm here, tell me what's happening.`,
      acknowledged: false,
    };

    state.alerts.unshift(alert);
    saveState(state);
    await sendOptionalAlertSms(alert, state.settings.caregiverPhone);
    res.json(alert);
  });

  // POST /api/messages
  app.post('/api/messages', (req, res) => {
    const { text, photoDataUrl } = req.body ?? {};
    if (
      (typeof text !== 'string' || !text.trim()) &&
      (typeof photoDataUrl !== 'string' || !photoDataUrl.trim())
    ) {
      res.status(400).json({ error: 'Please write a message or attach a photo.' });
      return;
    }

    const message: FamilyMessage = {
      id: makeId('msg'),
      at: new Date().toISOString(),
      from: state.settings.caregiverName,
      text: typeof text === 'string' ? text.trim() : '',
      photoDataUrl: typeof photoDataUrl === 'string' && photoDataUrl ? photoDataUrl : null,
      playedAt: null,
    };

    state.messages.unshift(message);
    saveState(state);
    if (message.text) {
      void synthesizeWarmSpeechWav(`A message from ${message.from}. ${message.text}`).catch(
        () => {}
      );
    }
    res.json(message);
  });

  // POST /api/messages/:id/played
  app.post('/api/messages/:id/played', (req, res) => {
    const msg = state.messages.find((m) => m.id === req.params.id);
    if (!msg) {
      res.status(404).json({ error: 'Message not found.' });
      return;
    }
    if (!msg.playedAt) {
      msg.playedAt = new Date().toISOString();
      saveState(state);
    }
    res.json(msg);
  });

  // POST /api/contact
  app.post('/api/contact', (_req, res) => {
    state.settings.lastContactAt = new Date().toISOString();
    for (const alert of state.alerts) {
      if (alert.type === 'no_contact') {
        alert.acknowledged = true;
      }
    }
    saveState(state);
    res.json({ lastContactAt: state.settings.lastContactAt });
  });

  // POST /api/alerts/:id/ack
  app.post('/api/alerts/:id/ack', (req, res) => {
    const alert = state.alerts.find((a) => a.id === req.params.id);
    if (!alert) {
      res.status(404).json({ error: 'Alert not found.' });
      return;
    }
    alert.acknowledged = true;
    saveState(state);
    res.json(alert);
  });

  // POST /api/settings
  app.post('/api/settings', (req, res) => {
    const patch = req.body ?? {};
    if (typeof patch.seniorName === 'string' && patch.seniorName.trim()) {
      state.settings.seniorName = patch.seniorName.trim();
    }
    if (typeof patch.seniorPhone === 'string') {
      state.settings.seniorPhone = patch.seniorPhone.trim();
    }
    if (typeof patch.caregiverName === 'string' && patch.caregiverName.trim()) {
      state.settings.caregiverName = patch.caregiverName.trim();
    }
    if (typeof patch.caregiverPhone === 'string') {
      state.settings.caregiverPhone = patch.caregiverPhone.trim();
    }
    if (typeof patch.shareCheckinWords === 'boolean') {
      state.settings.shareCheckinWords = patch.shareCheckinWords;
    }
    if (typeof patch.noContactNudgeDays === 'number' && patch.noContactNudgeDays > 0) {
      state.settings.noContactNudgeDays = patch.noContactNudgeDays;
    }
    if (typeof patch.doseGraceMinutes === 'number' && patch.doseGraceMinutes >= 1) {
      state.settings.doseGraceMinutes = patch.doseGraceMinutes;
    }
    if (typeof patch.reminderLeadMinutes === 'number' && patch.reminderLeadMinutes >= 0) {
      state.settings.reminderLeadMinutes = patch.reminderLeadMinutes;
    }
    saveState(state);
    res.json(state.settings);
  });

  // POST /api/tts
  app.post('/api/tts', async (req, res) => {
    const rawText = req.body?.text;
    if (typeof rawText !== 'string' || !rawText.trim()) {
      res.status(400).json({ error: 'Text is required for speech synthesis.' });
      return;
    }
    try {
      const wavBuffer = await synthesizeWarmSpeechWav(rawText);
      res.setHeader('Content-Type', 'audio/wav');
      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.send(wavBuffer);
    } catch (err) {
      console.error('Gemini TTS synthesis failed:', err);
      const errMsg = err instanceof Error ? err.message : 'Speech synthesis unavailable.';
      res.status(500).json({ error: errMsg });
    }
  });

  // POST /api/demo/due-now
  app.post('/api/demo/due-now', (_req, res) => {
    const now = new Date();
    const dueDose = forceNextDoseDueNow(state, now, protectedPastDoseIds);
    saveState(state);
    res.json({ dueDose, state: buildPublicState(state, 'caregiver', now) });
  });

  // POST /api/demo/miss-dose
  app.post('/api/demo/miss-dose', async (_req, res) => {
    const { missedDose, newHighOrUrgentAlerts } = forceMissNextDose(
      state,
      new Date(),
      protectedPastDoseIds
    );
    saveState(state);
    for (const alert of newHighOrUrgentAlerts) {
      await sendOptionalAlertSms(alert, state.settings.caregiverPhone);
    }
    res.json({ missedDose, state: buildPublicState(state, 'caregiver', new Date()) });
  });

  // POST /api/demo/no-contact
  app.post('/api/demo/no-contact', (_req, res) => {
    forceSixDaysNoContact(state, new Date(), protectedPastDoseIds);
    saveState(state);
    res.json({ state: buildPublicState(state, 'caregiver', new Date()) });
  });

  // POST /api/demo/reset
  app.post('/api/demo/reset', (_req, res) => {
    const currentTz = state.settings.tzOffsetMinutes;
    state = createSeedState(new Date(), protectedPastDoseIds, currentTz);
    saveState(state);
    res.json({ state: buildPublicState(state, 'caregiver', new Date()) });
  });

  setInterval(() => {
    void executeScheduler();
  }, 20_000);

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Huddle server listening on http://localhost:${PORT}`);
  });
}

void startServer();
