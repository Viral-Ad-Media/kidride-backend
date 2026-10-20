const jwt = require('jsonwebtoken');
const { fetchUserById } = require('../lib/repository');

const BLOCKED_MESSAGE = 'This account has been blocked. Contact KidRide support if you think this is a mistake.';

const protect = async (req, res, next) => {
  try {
    if (!req.headers.authorization || !req.headers.authorization.startsWith('Bearer')) {
      return res.status(401).json({ message: 'Not authorized, no token' });
    }

    const token = req.headers.authorization.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await fetchUserById(decoded.id);

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
  } catch (error) {
    return res.status(401).json({ message: 'Not authorized, token failed' });
  }
};

module.exports = { protect, BLOCKED_MESSAGE };
