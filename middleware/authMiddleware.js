const jwt = require('jsonwebtoken');
const { fetchUserById } = require('../lib/repository');

const BLOCKED_MESSAGE = 'This account has been blocked. Contact KidRide support if you think this is a mistake.';

const protect = async (req, res, next) => {
  if (!req.headers.authorization || !req.headers.authorization.startsWith('Bearer')) {
    return res.status(401).json({ message: 'Not authorized, no token' });
  }

  let decoded;
  try {
    decoded = jwt.verify(req.headers.authorization.split(' ')[1], process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ message: 'Not authorized, token failed' });
  }

  // A database or network failure is not an auth failure: answer 503 so the
  // app keeps the session and retries instead of signing the user out.
  let user;
  try {
    user = await fetchUserById(decoded.id);
  } catch (error) {
    console.error('Unable to load the signed-in account', error);
    return res.status(503).json({ message: 'KidRide is having trouble connecting. Please try again in a moment.' });
  }

  if (!user) {
    return res.status(401).json({ message: 'Not authorized, user not found' });
  }

  // Tokens issued before the last logout-everywhere carry an older version.
  if ((Number(decoded.tv) || 0) !== user.tokenVersion) {
    return res.status(401).json({ message: 'Session expired. Please log in again.' });
  }

  if (user.isBlocked) {
    return res.status(403).json({ message: BLOCKED_MESSAGE, code: 'account_blocked' });
  }

  req.user = user;
  return next();
};

module.exports = { protect, BLOCKED_MESSAGE };
