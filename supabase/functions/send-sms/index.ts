import { Webhook } from 'https://esm.sh/standardwebhooks@1.0.0';

interface SendSmsHookPayload {
  user?: {
    phone?: string;
  };
  sms?: {
    otp?: string;
  };
} 

interface ThaiBulkSmsResponse {
  phone_number_list?: Array<{
    message_id?: string;
    number?: string;
    used_credit?: number;
  }>;
  bad_phone_number_list?: Array<{
    message?: string;
    number?: string;
  }>;
}

function requiredEnv(name: string): string {
  const value = Deno.env.get(name)?.trim();

  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }

  return value;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function hookError(status: number, message: string): Response {
  return json(
    {
      error: {
        http_code: status,
        message,
      },
    },
    status,
  );
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') {
    return hookError(405, 'Method not allowed');
  }

  const rawPayload = await request.text();
  let event: SendSmsHookPayload;

  try {
    const hookSecret = requiredEnv('SEND_SMS_HOOK_SECRET').replace(
      /^v1,whsec_/,
      '',
    );
    const webhook = new Webhook(hookSecret);

    event = webhook.verify(
      rawPayload,
      Object.fromEntries(request.headers),
    ) as SendSmsHookPayload;
  } catch {
    // ห้าม log rawPayload เพราะมีทั้งเบอร์โทรและ OTP
    console.error('send-sms: invalid Supabase hook signature');
    return hookError(401, 'Invalid hook signature');
  }

  const phone = event.user?.phone;
  const otp = event.sms?.otp;

  if (!phone || !otp || !/^\d{4,10}$/.test(otp)) {
    return hookError(400, 'Invalid Send SMS hook payload');
  }

  try {
    const apiKey = requiredEnv('THAIBULKSMS_API_KEY');
    const apiSecret = requiredEnv('THAIBULKSMS_API_SECRET');
    const sender = requiredEnv('THAIBULKSMS_SENDER');
    const basicAuth = btoa(`${apiKey}:${apiSecret}`);

    const body = new URLSearchParams({
      sender,
      msisdn: phone,
      message: `รหัสยืนยัน Payung: ${otp} ห้ามเปิดเผยรหัสนี้แก่ผู้อื่น`,
      force: 'corporate',
    });

    // HTTP Auth Hooks ต้องตอบภายใน 5 วินาที จึงเผื่อเวลาให้ Supabase
    const response = await fetch('https://api-v2.thaibulksms.com/sms', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basicAuth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
      signal: AbortSignal.timeout(4_000),
    });

    if (!response.ok) {
      // ไม่ log response body เพราะผู้ให้บริการอาจส่งเบอร์โทรกลับมา
      console.error('send-sms: ThaiBulkSMS rejected request', {
        status: response.status,
      });
      return hookError(502, 'SMS provider rejected request');
    }

    const result = (await response.json()) as ThaiBulkSmsResponse;
    const hasRejectedNumber = (result.bad_phone_number_list?.length ?? 0) > 0;
    const hasAcceptedNumber = (result.phone_number_list?.length ?? 0) > 0;

    if (hasRejectedNumber || !hasAcceptedNumber) {
      console.error('send-sms: ThaiBulkSMS did not accept recipient');
      return hookError(502, 'SMS recipient was rejected');
    }

    // Send SMS Hook ไม่ต้องมี output; {} กับ HTTP 200 หมายถึงสำเร็จ
    return json({});
  } catch (error) {
    // ไม่ log error message เพราะ upstream error อาจมีเบอร์โทร
    console.error('send-sms: provider call failed', {
      errorType: error instanceof Error ? error.name : 'UnknownError',
    });
    return hookError(502, 'Unable to send SMS');
  }
});
