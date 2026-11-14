import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  Camera,
  Check,
  FileText,
  Loader2,
  Pill,
  Trash2,
  Upload,
} from 'lucide-react';
import type { Medication } from '../shared/types';
import {
  assetUrlToDownscaledDataUrl,
  DEMO_IMAGES,
  downscaleBlobToDataUrl,
  matchDefaultPillImageByName,
  PILL_IMAGES,
  readApiJson,
  SAMPLE_AMLODIPINE_TEXT,
  SAMPLE_NAPROXEN_TEXT,
} from '../utils/clientHelpers';

interface MedicationScannerProps {
  drafts: Medication[];
  onRefresh: () => Promise<void>;
}

interface DraftFormValues {
  name: string;
  strength: string;
  dose: string;
  instructions: string;
  timesInput: string;
  withFood: 'yes' | 'no' | 'unspecified';
  purpose: string;
  startedOn: string;
  pharmacistQuestionsText: string;
  pillPhotoDataUrl: string | null;
}

function buildInitialDraftForm(draft: Medication): DraftFormValues {
  return {
    name: draft.name || '',
    strength: draft.strength || '',
    dose: draft.dose || '',
    instructions: draft.instructions || '',
    timesInput: draft.times.length > 0 ? draft.times.join(', ') : '08:00',
    withFood: draft.withFood === true ? 'yes' : draft.withFood === false ? 'no' : 'unspecified',
    purpose: draft.purpose || '',
    startedOn: draft.startedOn || new Date().toISOString().slice(0, 10),
    pharmacistQuestionsText: draft.pharmacistQuestions.join('\n'),
    pillPhotoDataUrl: draft.pillPhotoDataUrl || null,
  };
}

export const MedicationScanner: React.FC<MedicationScannerProps> = ({ drafts, onRefresh }) => {
  const [isScannerOpen, setIsScannerOpen] = useState(false);
  const [scanMode, setScanMode] = useState<'photo' | 'text'>('photo');
  const [previewDataUrl, setPreviewDataUrl] = useState<string | null>(null);
  const [scanPillPhotoDataUrl, setScanPillPhotoDataUrl] = useState<string | null>(null);
  const [labelText, setLabelText] = useState('');
  const [scanning, setScanning] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const activeDraft = drafts[0] || null;
  const [formValues, setFormValues] = useState<DraftFormValues | null>(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (activeDraft) {
      setFormValues(buildInitialDraftForm(activeDraft));
    } else {
      setFormValues(null);
    }
  }, [activeDraft?.id]);

  const postScanLabel = async (payload: {
    imageDataUrl?: string;
    labelText?: string;
    pillPhotoDataUrl?: string | null;
  }) => {
    const res = await fetch('/api/medications/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await readApiJson<Medication & { error?: string }>(
      res,
      "We couldn't read that label right now. Please try pasting the label text or scanning again."
    );
    if (!res.ok) {
      throw new Error(data.error || 'Unable to scan label.');
    }
    return data;
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setErrorMsg(null);
    try {
      const dataUrl = await downscaleBlobToDataUrl(file, 800);
      setPreviewDataUrl(dataUrl);
    } catch {
      setErrorMsg('Could not read that photo. Please try another image or paste the label text.');
    }
  };

  const handleScanPillPhotoChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setErrorMsg(null);
    try {
      const dataUrl = await downscaleBlobToDataUrl(file, 600);
      setScanPillPhotoDataUrl(dataUrl);
    } catch {
      setErrorMsg('Could not read that pill photo. Please try another image.');
    }
  };

  const handleDraftPillPhotoChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !formValues) return;
    setErrorMsg(null);
    try {
      const dataUrl = await downscaleBlobToDataUrl(file, 600);
      setFormValues({ ...formValues, pillPhotoDataUrl: dataUrl });
    } catch {
      setErrorMsg('Could not read that pill photo. Please try another image.');
    }
  };

  const handleSamplePhotoScan = async (bottleAssetUrl: string, pillAssetUrl: string) => {
    setErrorMsg(null);
    setScanning(true);
    try {
      const [bottleDataUrl, pillDataUrl] = await Promise.all([
        assetUrlToDownscaledDataUrl(bottleAssetUrl, 800),
        assetUrlToDownscaledDataUrl(pillAssetUrl, 600),
      ]);
      setPreviewDataUrl(bottleDataUrl);
      await postScanLabel({
        imageDataUrl: bottleDataUrl,
        pillPhotoDataUrl: scanPillPhotoDataUrl || pillDataUrl,
      });
      setIsScannerOpen(false);
      setPreviewDataUrl(null);
      setScanPillPhotoDataUrl(null);
      await onRefresh();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Scan failed. Please try text fallback.');
    } finally {
      setScanning(false);
    }
  };

  const handleRunScan = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    if (!previewDataUrl && !labelText.trim()) {
      setErrorMsg('Choose a pill bottle photo or paste the printed label text first.');
      return;
    }

    setScanning(true);
    try {
      await postScanLabel({
        imageDataUrl: previewDataUrl || undefined,
        labelText: labelText.trim() || undefined,
        pillPhotoDataUrl: scanPillPhotoDataUrl || undefined,
      });
      setLabelText('');
      setPreviewDataUrl(null);
      setScanPillPhotoDataUrl(null);
      setIsScannerOpen(false);
      await onRefresh();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Unable to scan label.');
    } finally {
      setScanning(false);
    }
  };

  const handleConfirmDraft = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeDraft || !formValues) return;
    if (!formValues.name.trim()) {
      setErrorMsg('Please enter the medication name before confirming.');
      return;
    }

    setConfirming(true);
    setErrorMsg(null);
    try {
      const parsedTimes = formValues.timesInput
        .split(',')
        .map((t) => t.trim())
        .filter((t) => /^\d{2}:\d{2}$/.test(t));

      const questions = formValues.pharmacistQuestionsText
        .split('\n')
        .map((q) => q.trim())
        .filter(Boolean);

      const res = await fetch(`/api/medications/${activeDraft.id}/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: formValues.name.trim(),
          strength: formValues.strength.trim(),
          dose: formValues.dose.trim(),
          instructions: formValues.instructions.trim(),
          times: parsedTimes.length > 0 ? parsedTimes : ['08:00'],
          withFood:
            formValues.withFood === 'yes'
              ? true
              : formValues.withFood === 'no'
                ? false
                : null,
          purpose: formValues.purpose.trim() || null,
          startedOn: formValues.startedOn,
          pharmacistQuestions: questions,
          pillPhotoDataUrl: formValues.pillPhotoDataUrl,
        }),
      });
      const data = await readApiJson<Medication & { error?: string }>(
        res,
        'Failed to confirm medication.'
      );
      if (!res.ok) {
        throw new Error(data.error || 'Failed to confirm medication.');
      }
      await onRefresh();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to confirm medication.');
    } finally {
      setConfirming(false);
    }
  };

  const handleDiscardDraft = async (draftId: string) => {
    setConfirming(true);
    setErrorMsg(null);
    try {
      const res = await fetch(`/api/medications/${draftId}`, { method: 'DELETE' });
      if (!res.ok) {
        throw new Error('Could not discard medication draft.');
      }
      await onRefresh();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Could not discard medication draft.');
    } finally {
      setConfirming(false);
    }
  };

  const isFieldFlagged = (fieldName: string, currentValue: string): boolean => {
    if (!activeDraft) return false;
    const unreadable = activeDraft.unreadableFields.map((f) => f.toLowerCase());
    if (unreadable.includes(fieldName.toLowerCase())) return true;
    if (activeDraft.confidence === 'low' && !currentValue.trim()) return true;
    if ((fieldName === 'name' || fieldName === 'strength' || fieldName === 'dose') && !currentValue.trim()) {
      return true;
    }
    return false;
  };

  const fieldInputClass = (fieldName: string, currentValue: string) => {
    const flagged = isFieldFlagged(fieldName, currentValue);
    if (flagged) {
      return 'w-full px-3 py-2 rounded-lg border border-amber-400 bg-amber-50 text-stone-900 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500';
    }
    return 'w-full px-3 py-2 rounded-lg border border-teal-300 bg-teal-50/50 text-stone-900 text-sm focus:outline-none focus:ring-2 focus:ring-teal-700';
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-lg font-bold text-stone-900">Medications &amp; Schedule</h3>
          <p className="text-xs text-stone-500">
            AI scans stay as drafts until you verify every field.
          </p>
        </div>
        {!activeDraft && (
          <button
            type="button"
            onClick={() => {
              setIsScannerOpen((prev) => !prev);
              setErrorMsg(null);
            }}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-teal-800 text-white text-sm font-semibold hover:bg-teal-900 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Camera className="w-4 h-4" aria-hidden="true" />
            <span>{isScannerOpen ? 'Close scanner' : 'Add by photo'}</span>
          </button>
        )}
      </div>

      {errorMsg && (
        <div
          role="alert"
          className="p-3.5 rounded-xl border border-red-300 bg-red-50 text-sm text-red-900"
        >
          {errorMsg}
        </div>
      )}

      {/* Draft Confirmation Form */}
      {activeDraft && formValues && (
        <form
          onSubmit={handleConfirmDraft}
          className="pt-4 border-t border-stone-200 space-y-4"
        >
          <div className="space-y-1">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs font-semibold text-teal-800">
                Draft from AI label scan · Confidence: {activeDraft.confidence}
              </p>
              <p className="text-xs text-stone-500">
                Teal = AI-filled · Amber = check bottle
              </p>
            </div>
            <h4 className="text-base font-bold text-stone-900">
              Confirm {formValues.name || 'scanned medication'} before adding to schedule
            </h4>
          </div>

          {(activeDraft.confidence !== 'high' || activeDraft.unreadableFields.length > 0) && (
            <div className="p-3 rounded-lg bg-amber-50 text-xs text-amber-950 flex items-start gap-2.5">
              <AlertTriangle className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" aria-hidden="true" />
              <div>
                <p className="font-semibold">Please check highlighted fields against the bottle</p>
                {activeDraft.unreadableFields.length > 0 && (
                  <p className="mt-0.5">
                    Unreadable on label: {activeDraft.unreadableFields.join(', ')}
                  </p>
                )}
              </div>
            </div>
          )}

          <div>
            <label htmlFor="draft-name" className="block text-xs font-semibold text-stone-700 mb-1">
              Medication name *
            </label>
            <input
              id="draft-name"
              type="text"
              required
              value={formValues.name}
              onChange={(e) => setFormValues({ ...formValues, name: e.target.value })}
              className={fieldInputClass('name', formValues.name)}
              placeholder="e.g. Amlodipine"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor="draft-strength" className="block text-xs font-semibold text-stone-700 mb-1">
                Strength
              </label>
              <input
                id="draft-strength"
                type="text"
                value={formValues.strength}
                onChange={(e) => setFormValues({ ...formValues, strength: e.target.value })}
                className={fieldInputClass('strength', formValues.strength)}
                placeholder="e.g. 5 mg"
              />
            </div>
            <div>
              <label htmlFor="draft-dose" className="block text-xs font-semibold text-stone-700 mb-1">
                Dose
              </label>
              <input
                id="draft-dose"
                type="text"
                value={formValues.dose}
                onChange={(e) => setFormValues({ ...formValues, dose: e.target.value })}
                className={fieldInputClass('dose', formValues.dose)}
                placeholder="e.g. 1 tablet"
              />
            </div>
          </div>

          {/* Picture of the Actual Pill (Not the Bottle) */}
          <div className="p-3.5 rounded-xl border border-stone-200 bg-stone-50 space-y-2.5">
            <div className="flex items-start gap-3">
              {(() => {
                const resolvedDraftPillImg =
                  formValues.pillPhotoDataUrl ||
                  matchDefaultPillImageByName(formValues.name, formValues.purpose);
                return resolvedDraftPillImg ? (
                  <img
                    src={resolvedDraftPillImg}
                    alt={`${formValues.name || 'Medication'} pill appearance`}
                    referrerPolicy="no-referrer"
                    className="w-16 h-16 rounded-xl object-cover border border-stone-200 bg-white shrink-0"
                  />
                ) : (
                  <div className="w-16 h-16 rounded-xl border border-dashed border-stone-300 bg-white flex items-center justify-center text-stone-400 shrink-0">
                    <Pill className="w-6 h-6" aria-hidden="true" />
                  </div>
                );
              })()}
              <div className="flex-1 min-w-0 space-y-1.5">
                <div>
                  <p className="text-xs font-semibold text-stone-800">
                    Picture of the pill (not the bottle)
                  </p>
                  <p className="text-xs text-stone-500">
                    Shown in your pill list, and shown to Margaret only when it is time to take it.
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <label
                    htmlFor="draft-pill-photo-input"
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-stone-300 bg-white text-xs font-semibold text-stone-800 hover:bg-stone-100 cursor-pointer whitespace-nowrap shrink-0"
                  >
                    <Camera className="w-3.5 h-3.5 text-teal-800" aria-hidden="true" />
                    <span>
                      {formValues.pillPhotoDataUrl ? 'Replace pill photo' : 'Take or upload pill photo'}
                    </span>
                    <input
                      id="draft-pill-photo-input"
                      type="file"
                      accept="image/*"
                      capture="environment"
                      onChange={(e) => void handleDraftPillPhotoChange(e)}
                      className="sr-only"
                    />
                  </label>
                  {formValues.pillPhotoDataUrl && (
                    <button
                      type="button"
                      onClick={() => setFormValues({ ...formValues, pillPhotoDataUrl: null })}
                      className="text-xs font-semibold text-red-700 hover:underline cursor-pointer"
                    >
                      Remove custom photo
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>

          <div>
            <label htmlFor="draft-instructions" className="block text-xs font-semibold text-stone-700 mb-1">
              Printed instructions
            </label>
            <input
              id="draft-instructions"
              type="text"
              value={formValues.instructions}
              onChange={(e) => setFormValues({ ...formValues, instructions: e.target.value })}
              className={fieldInputClass('instructions', formValues.instructions)}
              placeholder="Take one tablet by mouth once daily"
            />
          </div>

          <div>
            <label htmlFor="draft-purpose" className="block text-xs font-semibold text-stone-700 mb-1">
              Plain-language purpose
            </label>
            <input
              id="draft-purpose"
              type="text"
              value={formValues.purpose}
              onChange={(e) => setFormValues({ ...formValues, purpose: e.target.value })}
              className={fieldInputClass('purpose', formValues.purpose)}
              placeholder="e.g. for blood pressure"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor="draft-times" className="block text-xs font-semibold text-stone-700 mb-1">
                Times (24h, comma-separated)
              </label>
              <input
                id="draft-times"
                type="text"
                value={formValues.timesInput}
                onChange={(e) => setFormValues({ ...formValues, timesInput: e.target.value })}
                className={`${fieldInputClass('times', formValues.timesInput)} font-mono tabular-nums`}
                placeholder="08:00, 20:00"
              />
            </div>
            <div>
              <label htmlFor="draft-started" className="block text-xs font-semibold text-stone-700 mb-1">
                Started on
              </label>
              <input
                id="draft-started"
                type="date"
                value={formValues.startedOn}
                onChange={(e) => setFormValues({ ...formValues, startedOn: e.target.value })}
                className="w-full px-3 py-2 rounded-lg border border-stone-300 bg-white text-stone-900 text-sm font-mono tabular-nums focus:outline-none focus:ring-2 focus:ring-teal-700"
              />
            </div>
          </div>

          <div>
            <label htmlFor="draft-food" className="block text-xs font-semibold text-stone-700 mb-1">
              Take with food?
            </label>
            <select
              id="draft-food"
              value={formValues.withFood}
              onChange={(e) =>
                setFormValues({
                  ...formValues,
                  withFood: e.target.value as 'yes' | 'no' | 'unspecified',
                })
              }
              className="w-full px-3 py-2 rounded-lg border border-teal-300 bg-teal-50/50 text-stone-900 text-sm focus:outline-none focus:ring-2 focus:ring-teal-700"
            >
              <option value="unspecified">Not specified on label</option>
              <option value="yes">Yes, take with food</option>
              <option value="no">No (any time / empty stomach)</option>
            </select>
          </div>

          <div>
            <label htmlFor="draft-pharm" className="block text-xs font-semibold text-stone-700 mb-1">
              Questions for the pharmacist (one per line)
            </label>
            <textarea
              id="draft-pharm"
              rows={2}
              value={formValues.pharmacistQuestionsText}
              onChange={(e) =>
                setFormValues({ ...formValues, pharmacistQuestionsText: e.target.value })
              }
              placeholder="Ask your pharmacist about..."
              className="w-full px-3 py-2 rounded-lg border border-amber-300 bg-amber-50/60 text-stone-900 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500"
            />
            <p className="text-xs text-stone-500 mt-1">
              Not medical advice. Any question here becomes a gentle reminder on your dashboard.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3 pt-2">
            <button
              type="submit"
              disabled={confirming}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-teal-800 text-white text-sm font-semibold hover:bg-teal-900 disabled:opacity-60 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              {confirming ? (
                <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
              ) : (
                <Check className="w-4 h-4" aria-hidden="true" />
              )}
              <span>Confirm medication</span>
            </button>
            <button
              type="button"
              disabled={confirming}
              onClick={() => void handleDiscardDraft(activeDraft.id)}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg border border-stone-300 bg-white text-stone-700 text-sm font-semibold hover:bg-stone-100 disabled:opacity-60 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Trash2 className="w-4 h-4" aria-hidden="true" />
              <span>Discard draft</span>
            </button>
          </div>
        </form>
      )}

      {/* Scanner Input Drawer */}
      {isScannerOpen && !activeDraft && (
        <div className="p-5 rounded-xl border border-stone-300 bg-stone-50 space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div className="inline-flex p-1 rounded-lg bg-stone-200/80">
              <button
                type="button"
                onClick={() => setScanMode('photo')}
                className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  scanMode === 'photo'
                    ? 'bg-white text-stone-900 shadow-xs'
                    : 'text-stone-600 hover:text-stone-900'
                }`}
              >
                Camera or bottle photo
              </button>
              <button
                type="button"
                onClick={() => setScanMode('text')}
                className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  scanMode === 'text'
                    ? 'bg-white text-stone-900 shadow-xs'
                    : 'text-stone-600 hover:text-stone-900'
                }`}
              >
                Paste label text
              </button>
            </div>
          </div>

          <form onSubmit={handleRunScan} className="space-y-4">
            {scanMode === 'photo' ? (
              <div className="space-y-3">
                <label
                  htmlFor="bottle-photo-input"
                  className="flex flex-col items-center justify-center p-5 border border-dashed border-stone-400 rounded-xl bg-white hover:bg-stone-50 cursor-pointer text-center"
                >
                  <Upload className="w-6 h-6 text-teal-800 mb-2" aria-hidden="true" />
                  <span className="text-sm font-semibold text-stone-900">
                    Take photo or choose pill bottle image
                  </span>
                  <span className="text-xs text-stone-500 mt-0.5">
                    Downscaled locally before scanning
                  </span>
                  <input
                    id="bottle-photo-input"
                    type="file"
                    accept="image/*"
                    capture="environment"
                    onChange={(e) => void handleFileChange(e)}
                    className="sr-only"
                  />
                </label>

                {previewDataUrl && (
                  <div className="flex items-center gap-3 p-3 rounded-lg bg-white border border-stone-200">
                    <img
                      src={previewDataUrl}
                      alt="Selected medication bottle preview"
                      referrerPolicy="no-referrer"
                      className="w-16 h-16 object-cover rounded-md border border-stone-200"
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-semibold text-stone-800">Bottle photo ready</p>
                      <button
                        type="button"
                        onClick={() => setPreviewDataUrl(null)}
                        className="text-xs text-red-700 hover:underline mt-0.5 cursor-pointer"
                      >
                        Remove photo
                      </button>
                    </div>
                  </div>
                )}

                <div className="pt-1">
                  <p className="text-xs font-semibold text-stone-600 mb-2">
                    Or try a sample bottle photo from demo-assets:
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={scanning}
                      onClick={() =>
                        void handleSamplePhotoScan(
                          DEMO_IMAGES.amlodipineBottle,
                          PILL_IMAGES.amlodipine
                        )
                      }
                      className="px-3 py-2 rounded-lg border border-stone-300 bg-white text-xs font-semibold text-stone-800 hover:bg-stone-100 disabled:opacity-60 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      Scan sample: Amlodipine 5 mg
                    </button>
                    <button
                      type="button"
                      disabled={scanning}
                      onClick={() =>
                        void handleSamplePhotoScan(
                          DEMO_IMAGES.naproxenBottle,
                          PILL_IMAGES.naproxen
                        )
                      }
                      className="px-3 py-2 rounded-lg border border-stone-300 bg-white text-xs font-semibold text-stone-800 hover:bg-stone-100 disabled:opacity-60 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      Scan sample: Naproxen 220 mg
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="space-y-2.5">
                <label htmlFor="label-text-input" className="block text-xs font-semibold text-stone-700">
                  Paste printed pharmacy label text
                </label>
                <textarea
                  id="label-text-input"
                  rows={3}
                  value={labelText}
                  onChange={(e) => setLabelText(e.target.value)}
                  placeholder="WALGREENS  Rx# 123456  AMLODIPINE 5 MG TABLETS  TAKE ONE TABLET BY MOUTH ONCE DAILY..."
                  className="w-full px-3 py-2 rounded-lg border border-stone-300 bg-white text-sm text-stone-900 font-mono focus:outline-none focus:ring-2 focus:ring-teal-700"
                />
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => setLabelText(SAMPLE_AMLODIPINE_TEXT)}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-stone-300 bg-white text-xs font-semibold text-stone-700 hover:bg-stone-100 whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <FileText className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>Fill sample Amlodipine 5 mg text</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setLabelText(SAMPLE_NAPROXEN_TEXT)}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-stone-300 bg-white text-xs font-semibold text-stone-700 hover:bg-stone-100 whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <FileText className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>Fill sample Naproxen 220 mg text</span>
                  </button>
                </div>
              </div>
            )}

            {/* Optional Pill Photo Step Right During Scan */}
            <div className="p-3.5 rounded-xl bg-white border border-stone-200 flex items-center gap-3">
              {scanPillPhotoDataUrl ? (
                <img
                  src={scanPillPhotoDataUrl}
                  alt="Selected pill preview"
                  referrerPolicy="no-referrer"
                  className="w-14 h-14 rounded-lg object-cover border border-stone-200 shrink-0"
                />
              ) : (
                <div className="w-14 h-14 rounded-lg border border-dashed border-stone-300 bg-stone-50 flex items-center justify-center text-stone-400 shrink-0">
                  <Pill className="w-5 h-5" aria-hidden="true" />
                </div>
              )}
              <div className="flex-1 min-w-0 space-y-1">
                <p className="text-xs font-semibold text-stone-800">
                  Photo of the actual pill (optional now, or add on next step)
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <label
                    htmlFor="scan-pill-photo-input"
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-stone-300 bg-stone-50 text-xs font-semibold text-stone-700 hover:bg-stone-100 cursor-pointer whitespace-nowrap shrink-0"
                  >
                    <Camera className="w-3.5 h-3.5 text-teal-800" aria-hidden="true" />
                    <span>{scanPillPhotoDataUrl ? 'Change pill photo' : 'Add pill photo'}</span>
                    <input
                      id="scan-pill-photo-input"
                      type="file"
                      accept="image/*"
                      capture="environment"
                      onChange={(e) => void handleScanPillPhotoChange(e)}
                      className="sr-only"
                    />
                  </label>
                  {scanPillPhotoDataUrl && (
                    <button
                      type="button"
                      onClick={() => setScanPillPhotoDataUrl(null)}
                      className="text-xs text-red-700 hover:underline cursor-pointer"
                    >
                      Remove
                    </button>
                  )}
                </div>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <button
                type="submit"
                disabled={scanning}
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-teal-800 text-white text-sm font-semibold hover:bg-teal-900 disabled:opacity-60 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                {scanning && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}
                <span>{scanning ? 'Reading label with AI…' : 'Scan label into draft'}</span>
              </button>
              <button
                type="button"
                disabled={scanning}
                onClick={() => setIsScannerOpen(false)}
                className="px-3 py-2 text-sm font-semibold text-stone-600 hover:text-stone-900 whitespace-nowrap shrink-0 cursor-pointer"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
