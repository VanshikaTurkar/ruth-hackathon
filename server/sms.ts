import type { Alert } from '../src/shared/types.ts';

export async function sendOptionalAlertSms(
  alert: Alert,
  fallbackCaregiverPhone: string
): Promise<void> {
  if (alert.severity !== 'high' && alert.severity !== 'urgent') {
    return;
  }

  const accountSid = process.env.TWILIO_ACCOUNT_SID?.trim();
  const authToken = process.env.TWILIO_AUTH_TOKEN?.trim();
  const fromPhone = process.env.TWILIO_FROM?.trim();
  const toPhone = (process.env.CAREGIVER_PHONE || fallbackCaregiverPhone || '').trim();

  if (!accountSid || !authToken || !fromPhone || !toPhone) {
    return;
  }

  try {
    const endpoint = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(
      accountSid
    )}/Messages.json`;
    const body = new URLSearchParams({
      From: fromPhone,
      To: toPhone,
      Body: `[Huddle ${alert.severity.toUpperCase()}] ${alert.title}: ${alert.body}`,
    });

    const credentials = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
    await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });
  } catch {
    // Optional SMS fails silently so dashboard alerts are never blocked
  }
}
