const router = require('express').Router();
const { protect } = require('../middleware/authMiddleware');
const { createRateLimiter } = require('../middleware/rateLimitMiddleware');
router.post('/', protect, createRateLimiter({ max: 20, keyPrefix: 'safety', keyGenerator: req => req.user.id }), async (req, res) => {
  const message = req.body.message;
  if (typeof message !== 'string' || !message.trim() || message.length > 2000) return res.status(400).json({ message: 'Provide a message of 1 to 2000 characters.' });
  if (!process.env.GEMINI_API_KEY) return res.status(503).json({ message: 'Safety assistant is temporarily unavailable.' });
  try {
    const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY }, signal: AbortSignal.timeout(20000), body: JSON.stringify({ contents: [{ parts: [{ text: message }] }], systemInstruction: { parts: [{ text: 'You are the KidRide safety assistant. Offer concise general safety guidance. You cannot dispatch help, monitor a ride, diagnose medical conditions, or verify a driver. For immediate danger direct users to local emergency services. Tell users to check the assigned driver identity, vehicle plate, trip code and safe word before pickup. GPS may be stale or unavailable. Do not claim background checks or safety guarantees. Never request passwords, SSNs, or unnecessary personal details.' }] } }) });
    if (!response.ok) throw new Error('Provider unavailable');
    const data = await response.json();
    const reply = data.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('');
    if (!reply) throw new Error('Empty response');
    return res.json({ response: reply });
  } catch { return res.status(503).json({ message: 'Safety assistant is temporarily unavailable. Contact local emergency services for urgent help.' }); }
});
module.exports = router;
