// Forgot password: a one-time link (random token, only its SHA-256 hash is stored)
// that is valid for 30 minutes. Emails go through Resend; until a sending domain is
// verified there, Resend only delivers to the account owner's own address.
const { randomBytes, createHash } = require('node:crypto');
const { supabaseAdmin } = require('../config/supabase');

const TTL_MS = 30 * 60 * 1000;
const hash = (token) => createHash('sha256').update(String(token)).digest('hex');
const frontendUrl = () => (process.env.FRONTEND_URLS || '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean)[0] || 'http://localhost:3001';
const validPassword = (password) => typeof password === 'string' && password.length >= 8 && password.length <= 72;

const sendResetEmail = async (to, link) => {
  if (!process.env.RESEND_API_KEY) { console.warn('Password reset email not sent: RESEND_API_KEY is not set'); return false; }
  const from = process.env.EMAIL_FROM || 'KidRide <onboarding@resend.dev>';
  const html = `<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#14213D">
    <h1 style="font-size:20px;margin:0 0 12px">Reset your KidRide password</h1>
    <p style="font-size:16px;line-height:1.5;color:#5B6478">Someone asked to reset the password for this account. The link works once, for 30 minutes.</p>
    <a href="${link}" style="display:inline-block;background:#38BDF8;color:#14213D;font-weight:600;text-decoration:none;padding:14px 24px;border-radius:9999px">Choose a new password</a>
    <p style="font-size:12px;color:#5B6478;margin-top:24px">If this wasn't you, ignore this email. Your password stays the same.</p></div>`;
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject: 'Reset your KidRide password', html, text: `Reset your KidRide password (link valid 30 minutes): ${link}\n\nIf this wasn't you, ignore this email.` }),
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) console.warn('Password reset email not sent', response.status);
    return response.ok;
  } catch (error) { console.warn('Password reset email not sent', error?.message || error); return false; }
};

/** Always resolves the same way whether or not the account exists, so emails cannot be probed. */
const requestReset = async (email) => {
  const { data: profile, error } = await supabaseAdmin.from('profiles').select('id, email, is_blocked').eq('email', email).maybeSingle();
  if (error) throw error;
  if (!profile || profile.is_blocked) return;
  const token = randomBytes(32).toString('hex');
  // One live link per account: older unused links stop working.
  await supabaseAdmin.from('password_resets').update({ used_at: new Date().toISOString() }).eq('user_id', profile.id).is('used_at', null);
  const { error: insertError } = await supabaseAdmin.from('password_resets').insert({ token_hash: hash(token), user_id: profile.id, expires_at: new Date(Date.now() + TTL_MS).toISOString() });
  if (insertError) throw insertError;
  await sendResetEmail(profile.email, `${frontendUrl()}/#/reset-password?token=${token}`);
};

/** Sets the new password and signs the account out everywhere. Returns false for a bad or used link. */
const completeReset = async (token, password) => {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return false;
  const now = new Date().toISOString();
  // Claim the link atomically so it cannot be used twice.
  const { data: row, error } = await supabaseAdmin.from('password_resets').update({ used_at: now })
    .eq('token_hash', hash(token)).is('used_at', null).gt('expires_at', now).select('user_id').maybeSingle();
  if (error) throw error;
  if (!row) return false;
  const { error: authError } = await supabaseAdmin.auth.admin.updateUserById(row.user_id, { password });
  if (authError) throw authError;
  const { data: profile } = await supabaseAdmin.from('profiles').select('token_version').eq('id', row.user_id).single();
  await supabaseAdmin.from('profiles').update({ token_version: (Number(profile?.token_version) || 0) + 1 }).eq('id', row.user_id);
  return true;
};

module.exports = { requestReset, completeReset, validPassword, hash };
