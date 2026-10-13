// Errors we raise deliberately carry a 4xx/503 `status` and a user-safe message.
// Anything else (database, network, bugs) is logged and returned generically so
// constraint names, columns and stack details never reach clients.
const sendError = (res, error, fallback = 'Request failed') => {
  if (error?.code === '23505') {
    return res.status(409).json({ message: 'An active ride already exists for this account' });
  }
  const status = Number(error?.status);
  if ((status >= 400 && status < 500) || status === 503) {
    return res.status(status).json({ message: error.message || fallback });
  }
  console.error(fallback, error);
  return res.status(500).json({ message: fallback });
};

module.exports = { sendError };
