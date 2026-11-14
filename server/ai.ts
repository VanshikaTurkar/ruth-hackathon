import { GoogleGenAI, Type, type Schema } from '@google/genai';
import {
  DEFAULT_GEMINI_MODEL,
  ensureWavAudioBytes,
  resolveGeminiModelName,
} from '../src/shared/careLogic.ts';
import type {
  CheckIn,
  CheckInAIOutput,
  ConfidenceLevel,
  Medication,
  ScanLabelOutput,
} from '../src/shared/types.ts';

export const MEDICATION_SCAN_SYSTEM_PROMPT = `You read prescription and over-the-counter medication labels for a family caregiving app.
Extract only what is printed. Never guess a value you cannot read — list it in unreadableFields instead and leave it null or "".
Map frequency to default times (24h): once daily → ["08:00"]; twice daily → ["08:00","20:00"]; three times daily → ["08:00","14:00","20:00"]; at bedtime → ["21:00"]; every morning → ["08:00"]; every evening → ["19:00"].
"purpose" is a short plain-language phrase only if it's printed or the drug's common use is well known (e.g. "for blood pressure"); otherwise null.
pharmacistQuestions: given the existing medications list, write at most 2 short questions the family could ask a pharmacist about possible interactions or duplicates, phrased as "Ask your pharmacist about …". Do not state that an interaction definitely exists. Empty array if nothing notable.
Return ONLY JSON:
{"name": string, "strength": string, "dose": string, "instructions": string, "times": string[], "withFood": boolean|null, "purpose": string|null, "confidence": "high"|"medium"|"low", "unreadableFields": string[], "pharmacistQuestions": string[]}`;

export const CHECKIN_SYSTEM_PROMPT = `You help a family stay connected with an older adult by summarizing her short daily spoken check-in.
You are not a doctor. Do not diagnose. Do not suggest changing medication.
1. summary: 1–2 warm, plain sentences for the family.
2. mood: good | okay | low | unclear.
3. concerns: anything health- or safety-relevant (falls, dizziness, pain, confusion, not eating, poor sleep, loneliness, missed meals). severity: low | medium | high | urgent.
   - urgent: chest pain, trouble breathing, stroke signs (face drooping, slurred speech, sudden weakness), a fall with injury or inability to get up, severe confusion, or any mention of wanting to die or self-harm.
   - If a symptom is a commonly known side effect of a medication started within the last 14 days, set possibleMedication to that medication's name and phrase it as a possibility only.
   - Compare with recent check-ins; note if something is new or getting worse.
4. goodMoments: positive or personal things she mentioned (family, hobbies, plans, small joys) — these help family have real conversations.
5. suggestedOpener: one natural, caring sentence the family member could say when they call, referencing something she said. Not clinical.
6. replyToSenior: what the app says back to her aloud — warm, short (max 2 sentences), simple words. If urgent: tell her you've alerted her family and that she should call 911 now if it's an emergency. If she mentions wanting to die or self-harm: also tell her she can call or text 988 any time to talk to someone.
7. urgent: true if any concern is urgent.
Return ONLY JSON:
{"summary": string, "mood": string, "concerns": [{"text": string, "severity": string, "possibleMedication": string|null}], "goodMoments": string[], "suggestedOpener": string, "replyToSenior": string, "urgent": boolean}`;

const MEDICATION_SCAN_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    name: { type: Type.STRING },
    strength: { type: Type.STRING },
    dose: { type: Type.STRING },
    instructions: { type: Type.STRING },
    times: { type: Type.ARRAY, items: { type: Type.STRING } },
    withFood: { type: Type.BOOLEAN, nullable: true },
    purpose: { type: Type.STRING, nullable: true },
    confidence: { type: Type.STRING },
    unreadableFields: { type: Type.ARRAY, items: { type: Type.STRING } },
    pharmacistQuestions: { type: Type.ARRAY, items: { type: Type.STRING } },
  },
  required: [
    'name',
    'strength',
    'dose',
    'instructions',
    'times',
    'confidence',
    'unreadableFields',
    'pharmacistQuestions',
  ],
};

const CHECKIN_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    summary: { type: Type.STRING },
    mood: { type: Type.STRING },
    concerns: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          text: { type: Type.STRING },
          severity: { type: Type.STRING },
          possibleMedication: { type: Type.STRING, nullable: true },
        },
        required: ['text', 'severity'],
      },
    },
    goodMoments: { type: Type.ARRAY, items: { type: Type.STRING } },
    suggestedOpener: { type: Type.STRING },
    replyToSenior: { type: Type.STRING },
    urgent: { type: Type.BOOLEAN },
  },
  required: [
    'summary',
    'mood',
    'concerns',
    'goodMoments',
    'suggestedOpener',
    'replyToSenior',
    'urgent',
  ],
};

function getGeminiClient(apiVersion?: string): GoogleGenAI {
  const cleanApiKey = process.env.GEMINI_API_KEY?.trim().replace(/^["']+|["']+$/g, '');
  return new GoogleGenAI({
    apiKey: cleanApiKey,
    httpOptions: {
      ...(apiVersion ? { apiVersion } : {}),
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function extractJsonString(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced && fenced[1]) {
    return fenced[1].trim();
  }
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }
  return trimmed;
}

function parseDataUrl(dataUrl: string): { mimeType: string; base64: string } | null {
  const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!match) return null;
  return { mimeType: match[1], base64: match[2] };
}

async function callGeminiJsonWithRetry<T>(params: {
  systemPrompt: string;
  userText: string;
  schema: Schema;
  imageDataUrl?: string;
}): Promise<T> {
  const ai = getGeminiClient();
  let activeModel = resolveGeminiModelName(process.env.GEMINI_MODEL);

  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const retryReminder =
        attempt === 1
          ? '\n\nIMPORTANT: Return ONLY valid JSON matching the requested schema.'
          : '';

      const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> =
        [];
      if (params.imageDataUrl) {
        const parsed = parseDataUrl(params.imageDataUrl);
        if (parsed) {
          parts.push({
            inlineData: {
              mimeType: parsed.mimeType,
              data: parsed.base64,
            },
          });
        }
      }
      parts.push({ text: params.userText + retryReminder });

      const response = await ai.models.generateContent({
        model: activeModel,
        contents: { parts },
        config: {
          systemInstruction: params.systemPrompt,
          responseMimeType: 'application/json',
          responseSchema: params.schema,
        },
      });

      const jsonStr = extractJsonString(response.text ?? '');
      return JSON.parse(jsonStr) as T;
    } catch (err) {
      lastError = err;
      if (activeModel !== DEFAULT_GEMINI_MODEL) {
        activeModel = DEFAULT_GEMINI_MODEL;
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Unable to parse Gemini JSON response after retry.');
}

function normalizeConfidence(val: unknown): ConfidenceLevel {
  if (val === 'high' || val === 'medium' || val === 'low') return val;
  return 'medium';
}

export async function analyzeMedicationLabel(input: {
  imageDataUrl?: string;
  labelText?: string;
  confirmedMedications: Medication[];
}): Promise<ScanLabelOutput> {
  const existingList =
    input.confirmedMedications.length > 0
      ? input.confirmedMedications
          .map((m) => `- ${m.name} ${m.strength} (${m.instructions || 'confirmed'})`)
          .join('\n')
      : 'None';

  const userPromptParts = [
    `Existing confirmed medications:\n${existingList}`,
    input.labelText?.trim()
      ? `\nPrinted label text:\n${input.labelText.trim()}`
      : '\nPlease read the attached medication label image carefully.',
  ];

  const parsed = await callGeminiJsonWithRetry<Partial<ScanLabelOutput>>({
    systemPrompt: MEDICATION_SCAN_SYSTEM_PROMPT,
    userText: userPromptParts.join('\n'),
    schema: MEDICATION_SCAN_SCHEMA,
    imageDataUrl: input.imageDataUrl,
  });

  const times =
    Array.isArray(parsed.times) && parsed.times.length > 0
      ? parsed.times.filter((t): t is string => typeof t === 'string' && /^\d{2}:\d{2}$/.test(t))
      : ['08:00'];

  return {
    name: typeof parsed.name === 'string' ? parsed.name.trim() : '',
    strength: typeof parsed.strength === 'string' ? parsed.strength.trim() : '',
    dose: typeof parsed.dose === 'string' ? parsed.dose.trim() : '',
    instructions: typeof parsed.instructions === 'string' ? parsed.instructions.trim() : '',
    times: times.length > 0 ? times : ['08:00'],
    withFood:
      parsed.withFood === true || parsed.withFood === false ? parsed.withFood : null,
    purpose:
      typeof parsed.purpose === 'string' && parsed.purpose.trim().length > 0
        ? parsed.purpose.trim()
        : null,
    confidence: normalizeConfidence(parsed.confidence),
    unreadableFields: Array.isArray(parsed.unreadableFields)
      ? parsed.unreadableFields.filter((f): f is string => typeof f === 'string')
      : [],
    pharmacistQuestions: Array.isArray(parsed.pharmacistQuestions)
      ? parsed.pharmacistQuestions
          .filter((q): q is string => typeof q === 'string' && q.trim().length > 0)
          .slice(0, 2)
      : [],
  };
}

export async function analyzeCheckInTranscript(input: {
  seniorName: string;
  transcript: string;
  confirmedMedications: Medication[];
  recentCheckins: CheckIn[];
  todayIsoDate: string;
}): Promise<Partial<CheckInAIOutput>> {
  const medsDescription =
    input.confirmedMedications.length > 0
      ? input.confirmedMedications
          .map(
            (m) =>
              `- ${m.name} (${m.strength}, ${m.purpose || 'daily medication'}, startedOn: ${m.startedOn})`
          )
          .join('\n')
      : 'None';

  const recentSummaries =
    input.recentCheckins.length > 0
      ? input.recentCheckins
          .slice(0, 3)
          .map((c) => `- [${c.at.slice(0, 10)}] (mood: ${c.mood}) ${c.summary}`)
          .join('\n')
      : 'None';

  const userPrompt = [
    `Today's date: ${input.todayIsoDate}`,
    `Senior's name: ${input.seniorName}`,
    `\nConfirmed medications:\n${medsDescription}`,
    `\nLast 3 check-in summaries:\n${recentSummaries}`,
    `\nToday's spoken check-in transcript from ${input.seniorName}:\n"${input.transcript}"`,
  ].join('\n');

  return callGeminiJsonWithRetry<Partial<CheckInAIOutput>>({
    systemPrompt: CHECKIN_SYSTEM_PROMPT,
    userText: userPrompt,
    schema: CHECKIN_SCHEMA,
  });
}

const DEFAULT_TTS_MODEL = 'gemini-3.8-flash-lite-tts';
const DEFAULT_TTS_VOICE = 'Kore';
const MAX_TTS_CACHE_ENTRIES = 50;

const ttsAudioCache = new Map<string, Buffer>();
const inFlightTtsRequests = new Map<string, Promise<Buffer>>();

export async function synthesizeWarmSpeechWav(rawText: string): Promise<Buffer> {
  const cleanText = rawText.trim().replace(/\s+/g, ' ').slice(0, 800);
  if (!cleanText) {
    throw new Error('Cannot synthesize empty text.');
  }

  const cached = ttsAudioCache.get(cleanText);
  if (cached) {
    return cached;
  }

  const existingInFlight = inFlightTtsRequests.get(cleanText);
  if (existingInFlight) {
    return existingInFlight;
  }

  const generationPromise = (async () => {
    const ai = getGeminiClient('v1beta');

    const attempts: Array<{
      model: string;
      useSpeechMetadata: boolean;
    }> = [
      { model: DEFAULT_TTS_MODEL, useSpeechMetadata: true },
      { model: DEFAULT_TTS_MODEL, useSpeechMetadata: false },
      { model: 'gemini-3.8-flash-tts', useSpeechMetadata: true },
      { model: 'gemini-3.8-flash-tts', useSpeechMetadata: false },
    ];

    let lastErr: unknown = null;
    for (const attempt of attempts) {
      try {
        const part = attempt.useSpeechMetadata
          ? {
              text: cleanText,
              speechMetadata: {
                style:
                  'Warm, gentle, friendly, reassuring family companion speaking naturally and clearly at a relaxed, unhurried pace',
              },
            }
          : {
              text: cleanText,
            };

        const response = await ai.models.generateContent({
          model: attempt.model,
          contents: [
            {
              role: 'user',
              parts: [part],
            },
          ],
          config: {
            responseModalities: ['AUDIO'],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: DEFAULT_TTS_VOICE },
              },
            },
          },
        });

        const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
        if (!base64Audio) {
          throw new Error(`Model ${attempt.model} returned no inline audio data.`);
        }

        const rawBytes = Buffer.from(base64Audio, 'base64');
        const wavBytes = Buffer.from(ensureWavAudioBytes(rawBytes, 24000));

        if (ttsAudioCache.size >= MAX_TTS_CACHE_ENTRIES) {
          const oldestKey = ttsAudioCache.keys().next().value;
          if (oldestKey) {
            ttsAudioCache.delete(oldestKey);
          }
        }
        ttsAudioCache.set(cleanText, wavBytes);
        return wavBytes;
      } catch (err) {
        lastErr = err;
      }
    }

    throw lastErr instanceof Error
      ? lastErr
      : new Error('Gemini TTS did not return audio data.');
  })();

  inFlightTtsRequests.set(cleanText, generationPromise);
  try {
    return await generationPromise;
  } finally {
    inFlightTtsRequests.delete(cleanText);
  }
}
