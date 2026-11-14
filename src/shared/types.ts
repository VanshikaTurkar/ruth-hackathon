export interface Settings {
  seniorName: string;
  seniorPhone: string;
  caregiverName: string;
  caregiverPhone: string;
  shareCheckinWords: boolean;
  lastContactAt: string | null;
  noContactNudgeDays: number;
  doseGraceMinutes: number;
  reminderLeadMinutes?: number;
  tzOffsetMinutes?: number;
}

export type MedicationStatus = 'draft' | 'confirmed';
export type ConfidenceLevel = 'high' | 'medium' | 'low';

export interface Medication {
  id: string;
  name: string;
  strength: string;
  dose: string;
  instructions: string;
  times: string[];
  withFood: boolean | null;
  purpose: string | null;
  startedOn: string;
  status: MedicationStatus;
  confidence: ConfidenceLevel;
  unreadableFields: string[];
  pharmacistQuestions: string[];
  pillPhotoDataUrl?: string | null;
}

export type DoseStatus = 'pending' | 'taken' | 'missed';

export interface DoseEvent {
  id: string;
  medicationId: string;
  scheduledFor: string;
  status: DoseStatus;
  remindedAt: string | null;
  takenAt: string | null;
}

export type MoodLevel = 'good' | 'okay' | 'low' | 'unclear';
export type SeverityLevel = 'low' | 'medium' | 'high' | 'urgent';

export interface CheckInConcern {
  text: string;
  severity: SeverityLevel;
  possibleMedication: string | null;
}

export interface CheckIn {
  id: string;
  at: string;
  transcript?: string;
  keptPrivate: boolean;
  summary: string;
  mood: MoodLevel;
  concerns: CheckInConcern[];
  goodMoments: string[];
  suggestedOpener: string;
  urgent: boolean;
}

export type AlertType =
  | 'missed_dose'
  | 'checkin_concern'
  | 'help_button'
  | 'no_contact'
  | 'pharmacist_question';

export interface Alert {
  id: string;
  at: string;
  type: AlertType;
  severity: SeverityLevel;
  title: string;
  body: string;
  suggestedOpener: string | null;
  acknowledged: boolean;
}

export interface FamilyMessage {
  id: string;
  at: string;
  from: string;
  text: string;
  photoDataUrl: string | null;
  playedAt: string | null;
}

export interface AppState {
  settings: Settings;
  medications: Medication[];
  doses: DoseEvent[];
  checkins: CheckIn[];
  alerts: Alert[];
  messages: FamilyMessage[];
}

export interface ScanLabelOutput {
  name: string;
  strength: string;
  dose: string;
  instructions: string;
  times: string[];
  withFood: boolean | null;
  purpose: string | null;
  confidence: ConfidenceLevel;
  unreadableFields: string[];
  pharmacistQuestions: string[];
}

export interface CheckInAIOutput {
  summary: string;
  mood: MoodLevel;
  concerns: CheckInConcern[];
  goodMoments: string[];
  suggestedOpener: string;
  replyToSenior: string;
  urgent: boolean;
}
