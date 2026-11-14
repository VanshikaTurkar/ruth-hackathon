import amlodipineBottleImg from '../assets/images/amlodipine_pill_bottle_1794604951852.jpg';
import naproxenBottleImg from '../assets/images/naproxen_pill_bottle_1794604951709.jpg';
import familyGardenImg from '../assets/images/family_garden_tomatoes_1794604952760.jpg';
import pillMetforminImg from '../assets/images/pill_metformin_tablet_1794614901432.jpg';
import pillAtorvastatinImg from '../assets/images/pill_atorvastatin_tablet_1794614903610.jpg';
import pillLisinoprilImg from '../assets/images/pill_lisinopril_tablet_1794614904183.jpg';
import pillAmlodipineImg from '../assets/images/pill_amlodipine_tablet_1794614905633.jpg';
import pillNaproxenImg from '../assets/images/pill_naproxen_caplet_1794614905951.jpg';
import type { Medication } from '../shared/types';
import { scoreSpeechSynthesisVoice } from '../shared/careLogic';

export const DEMO_IMAGES = {
  amlodipineBottle: amlodipineBottleImg,
  naproxenBottle: naproxenBottleImg,
  familyGarden: familyGardenImg,
};

export const PILL_IMAGES = {
  metformin: pillMetforminImg,
  atorvastatin: pillAtorvastatinImg,
  lisinopril: pillLisinoprilImg,
  amlodipine: pillAmlodipineImg,
  naproxen: pillNaproxenImg,
};

export function matchDefaultPillImageByName(
  name: string,
  purpose?: string | null
): string | null {
  const lower = (name || '').trim().toLowerCase();
  const lowerPurpose = (purpose || '').trim().toLowerCase();
  if (!lower) return null;
  if (lower.includes('metformin')) return PILL_IMAGES.metformin;
  if (lower.includes('atorvastatin') || lower.includes('lipitor')) return PILL_IMAGES.atorvastatin;
  if (lower.includes('lisinopril')) return PILL_IMAGES.lisinopril;
  if (lower.includes('amlodipine') || lower.includes('norvasc')) return PILL_IMAGES.amlodipine;
  if (
    lower.includes('naproxen') ||
    lower.includes('aleve') ||
    lower.includes('generic medication') ||
    lowerPurpose.includes('pain')
  ) {
    return PILL_IMAGES.naproxen;
  }
  return null;
}

export function resolveMedicationPillImage(
  med: Pick<Medication, 'name' | 'purpose' | 'pillPhotoDataUrl'>
): string | null {
  if (typeof med.pillPhotoDataUrl === 'string' && med.pillPhotoDataUrl.trim()) {
    return med.pillPhotoDataUrl.trim();
  }
  return matchDefaultPillImageByName(med.name, med.purpose);
}

export const SAMPLE_AMLODIPINE_TEXT =
  'WALGREENS  Rx# 123456  AMLODIPINE 5 MG TABLETS  TAKE ONE TABLET BY MOUTH ONCE DAILY  Qty 30  Dr. A. Patel';

export const SAMPLE_NAPROXEN_TEXT =
  'CVS PHARMACY  Rx# 784920  NAPROXEN 220 MG TABLETS  TAKE ONE TABLET BY MOUTH TWICE DAILY WITH FOOD FOR JOINT PAIN  Qty 60  Dr. J. Smith';

const SILENT_WAV_DATA_URI =
  'data:audio/wav;base64,UklGRiYAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQIAAAAAAA==';

const ttsBlobUrlCache = new Map<string, string>();
const inFlightClientTts = new Map<string, Promise<string | null>>();
let sharedAudioElement: HTMLAudioElement | null = null;
let sharedAudioUnlocked = false;
let activeSpeechSeq = 0;

function normalizeSpeechKey(text: string): string {
  return text.trim().replace(/\s+/g, ' ').slice(0, 800);
}

function getSharedAudio(): HTMLAudioElement | null {
  if (typeof window === 'undefined' || typeof Audio === 'undefined') return null;
  if (!sharedAudioElement) {
    sharedAudioElement = new Audio();
    sharedAudioElement.preload = 'auto';
  }
  return sharedAudioElement;
}

function fetchTtsAudioUrl(cleanText: string): Promise<string | null> {
  const cached = ttsBlobUrlCache.get(cleanText);
  if (cached) {
    return Promise.resolve(cached);
  }
  const existing = inFlightClientTts.get(cleanText);
  if (existing) {
    return existing;
  }

  const requestPromise = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: cleanText }),
        signal: controller.signal,
      });
      const contentType = res.headers.get('content-type') || '';
      if (!res.ok || !contentType.toLowerCase().includes('audio')) {
        return null;
      }
      const arrayBuf = await res.arrayBuffer();
      if (arrayBuf.byteLength < 44) {
        return null;
      }
      const blob = new Blob([arrayBuf], { type: 'audio/wav' });
      const objectUrl = URL.createObjectURL(blob);
      if (ttsBlobUrlCache.size >= 40) {
        const oldestKey = ttsBlobUrlCache.keys().next().value;
        if (oldestKey) {
          const oldUrl = ttsBlobUrlCache.get(oldestKey);
          if (oldUrl) URL.revokeObjectURL(oldUrl);
          ttsBlobUrlCache.delete(oldestKey);
        }
      }
      ttsBlobUrlCache.set(cleanText, objectUrl);
      return objectUrl;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
      inFlightClientTts.delete(cleanText);
    }
  })();

  inFlightClientTts.set(cleanText, requestPromise);
  return requestPromise;
}

export function preloadSpeechAudio(text: string): void {
  if (typeof window === 'undefined') return;
  const cleanText = normalizeSpeechKey(text);
  if (!cleanText || ttsBlobUrlCache.has(cleanText)) return;
  void fetchTtsAudioUrl(cleanText);
}

function speakWithPleasantBrowserVoice(text: string, finish: () => void): void {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
    finish();
    return;
  }
  try {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    const voices = window.speechSynthesis.getVoices?.() || [];
    let bestVoice: SpeechSynthesisVoice | null = null;
    let bestScore = -Infinity;
    for (const v of voices) {
      const s = scoreSpeechSynthesisVoice(v);
      if (s > bestScore) {
        bestScore = s;
        bestVoice = v;
      }
    }
    if (bestVoice && bestScore > 0) {
      utterance.voice = bestVoice;
    }
    utterance.rate = 0.94;
    utterance.pitch = 1.02;
    utterance.onend = finish;
    utterance.onerror = finish;
    window.speechSynthesis.speak(utterance);
  } catch {
    finish();
  }
}

export function speakAloud(text: string, onEnd?: () => void): void {
  if (typeof window === 'undefined') {
    onEnd?.();
    return;
  }

  const cleanText = normalizeSpeechKey(text);
  if (!cleanText) {
    onEnd?.();
    return;
  }

  const seq = ++activeSpeechSeq;
  let called = false;
  const finish = () => {
    if (!called) {
      called = true;
      if (seq === activeSpeechSeq) {
        onEnd?.();
      }
    }
  };

  try {
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
  } catch {
    // Ignore speechSynthesis cancel errors
  }

  const audio = getSharedAudio();
  if (audio) {
    audio.onended = null;
    audio.onerror = null;
    try {
      audio.pause();
    } catch {
      // Ignore pause errors
    }
  }

  if (!audio) {
    speakWithPleasantBrowserVoice(cleanText, finish);
    return;
  }

  const playResolvedUrl = (url: string) => {
    if (seq !== activeSpeechSeq) return;
    audio.onended = finish;
    audio.onerror = () => {
      audio.onended = null;
      audio.onerror = null;
      if (seq === activeSpeechSeq) {
        speakWithPleasantBrowserVoice(cleanText, finish);
      }
    };
    audio.src = url;
    audio.currentTime = 0;
    const playPromise = audio.play();
    if (playPromise && typeof playPromise.then === 'function') {
      playPromise
        .then(() => {
          sharedAudioUnlocked = true;
        })
        .catch(() => {
          audio.onended = null;
          audio.onerror = null;
          if (seq === activeSpeechSeq) {
            speakWithPleasantBrowserVoice(cleanText, finish);
          }
        });
    }
  };

  const cachedUrl = ttsBlobUrlCache.get(cleanText);
  if (cachedUrl) {
    playResolvedUrl(cachedUrl);
    return;
  }

  // Unlock shared HTMLAudioElement synchronously inside mobile Safari user gestures
  if (!sharedAudioUnlocked) {
    try {
      audio.src = SILENT_WAV_DATA_URI;
      const unlockPromise = audio.play();
      if (unlockPromise && typeof unlockPromise.then === 'function') {
        unlockPromise
          .then(() => {
            sharedAudioUnlocked = true;
            if (seq === activeSpeechSeq && audio.src === SILENT_WAV_DATA_URI) {
              audio.pause();
            }
          })
          .catch(() => {
            // Autoplay without gesture; fallback will handle if needed
          });
      }
    } catch {
      // Ignore unlock errors
    }
  }

  void fetchTtsAudioUrl(cleanText).then((url) => {
    if (seq !== activeSpeechSeq) return;
    if (url) {
      playResolvedUrl(url);
    } else {
      speakWithPleasantBrowserVoice(cleanText, finish);
    }
  });
}

export function triggerGentleVibration(): void {
  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
    try {
      navigator.vibrate([200, 100, 200]);
    } catch {
      // Ignore if vibration blocked by browser gesture policy
    }
  }
}

export function formatClockTime(isoOrHhmm: string): string {
  if (!isoOrHhmm) return '';
  if (isoOrHhmm.includes('T')) {
    const d = new Date(isoOrHhmm);
    if (Number.isNaN(d.getTime())) return isoOrHhmm;
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }
  const [rawH, rawM] = isoOrHhmm.split(':');
  const h = Number.parseInt(rawH || '8', 10);
  const m = Number.parseInt(rawM || '0', 10);
  const d = new Date();
  d.setHours(Number.isFinite(h) ? h : 8, Number.isFinite(m) ? m : 0, 0, 0);
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

export function formatCheckinTimestamp(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday =
    d.getFullYear() === yesterday.getFullYear() &&
    d.getMonth() === yesterday.getMonth() &&
    d.getDate() === yesterday.getDate();

  const timeStr = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (sameDay) return `at ${timeStr}`;
  if (isYesterday) return `yesterday at ${timeStr}`;
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} at ${timeStr}`;
}

export function formatRelativeStartedOn(startedOn: string, now: Date = new Date()): string {
  const parsed = new Date(startedOn.length === 10 ? `${startedOn}T00:00:00` : startedOn);
  if (Number.isNaN(parsed.getTime())) return startedOn;
  const diffDays = Math.max(
    0,
    Math.floor((now.getTime() - parsed.getTime()) / (24 * 60 * 60 * 1000))
  );
  if (diffDays === 0) return 'started today';
  if (diffDays === 1) return 'started yesterday';
  if (diffDays < 30) return `started ${diffDays} days ago`;
  if (diffDays < 365) {
    const months = Math.floor(diffDays / 30);
    return `started ${months} month${months === 1 ? '' : 's'} ago`;
  }
  const years = Math.floor(diffDays / 365);
  return `started ${years} year${years === 1 ? '' : 's'} ago`;
}

export function getGreetingForTime(date: Date): string {
  const h = date.getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

export async function downscaleBlobToDataUrl(blob: Blob, maxDim = 800): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read image file.'));
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      const img = new Image();
      img.onerror = () => reject(new Error('Could not decode image.'));
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          if (width >= height) {
            height = Math.round((height * maxDim) / width);
            width = maxDim;
          } else {
            width = Math.round((width * maxDim) / height);
            height = maxDim;
          }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(dataUrl);
          return;
        }
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', 0.84));
      };
      img.src = dataUrl;
    };
    reader.readAsDataURL(blob);
  });
}

export async function assetUrlToDownscaledDataUrl(url: string, maxDim = 800): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error('Could not load sample image.');
  }
  const blob = await response.blob();
  return downscaleBlobToDataUrl(blob, maxDim);
}

export async function readApiJson<T>(res: Response, fallbackMessage: string): Promise<T> {
  const raw = await res.text();
  if (!raw || raw.trimStart().startsWith('<')) {
    throw new Error(fallbackMessage);
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(fallbackMessage);
  }
}

