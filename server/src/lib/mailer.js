/*
 * OAK's only outbound mail: the password-reset link. Nothing else may be sent from here —
 * a reset is mail the reader asked for by name, marketing is not, and mixing the two on
 * one sending domain is how a domain's reputation dies.
 *
 * Transport is Resend's HTTP API rather than SMTP, because a plain fetch() needs no
 * dependency and no long-lived connection on a service that sleeps.
 *
 * Nothing in this file may reject. The caller has already answered the request — see the
 * comment on POST /api/auth/forgot-password — so a mail failure has nowhere to go but the
 * log, and a thrown one would only surface as an unhandled rejection.
 */

const ENDPOINT = 'https://api.resend.com/emails';
// Resend refuses any From on an unverified domain, so this default only works once
// oakbeauty.vn is verified there; DEPLOY.md §7 walks through it.
const DEFAULT_FROM = 'OAK Beauty <no-reply@oakbeauty.vn>';
// The reader is already waiting on nothing — the reply went out first — but a request
// that never settles would pin a socket for as long as the process lives.
const TIMEOUT_MS = 10_000;

/**
 * Send one password-reset link to `to`. Returns whether it went out; never throws, and
 * never says anything about the address — no address is written to the log, because the
 * whole endpoint is built so that not even its timing tells a caller who has an account.
 *
 * Without RESEND_API_KEY there is no channel: nothing is sent and nothing is logged as a
 * failure, which is the ordinary state of a local checkout.
 */
export async function sendResetMail(to, url) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return false;
  }

  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: process.env.RESET_MAIL_FROM || DEFAULT_FROM,
        to,
        subject: 'Đặt lại mật khẩu OAK Beauty',
        // Plain text on purpose: it renders everywhere, cannot carry a tracker, and the
        // link is the entire message. The 30 minutes is RESET_TOKEN_TTL_MS in routes/auth.js.
        text: [
          'Bạn vừa yêu cầu đặt lại mật khẩu OAK Beauty.',
          '',
          'Mở liên kết dưới đây trong vòng 30 phút để đặt mật khẩu mới:',
          url,
          '',
          'Nếu không phải bạn yêu cầu, hãy bỏ qua email này — mật khẩu hiện tại vẫn giữ nguyên.',
        ].join('\n'),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!response.ok) {
      // Resend answers a refusal (unverified domain, bad key, quota) as JSON; it names the
      // reason, and this is the only place that reason is ever visible.
      console.error(
        'sendResetMail: Resend refused the message:',
        response.status,
        await response.text().catch(() => ''),
      );
      return false;
    }
    return true;
  } catch (error) {
    console.error('sendResetMail: could not reach Resend:', error);
    return false;
  }
}
