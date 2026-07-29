const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');

const MASTER_KEY_PATH = '/etc/raw-thingies/master.key';
const TOKEN_TTL = '12h';

// The JWT signing secret reuses the same master key install.sh generates for
// env var encryption (Section 10) - one securely-generated, 0600 file is
// simpler to operate than managing two secrets. Falls back to a random
// in-memory secret when the file doesn't exist (e.g. local dev on Windows,
// where the provisioning script never ran) so the API can still boot -
// tokens just won't survive a restart there.
let jwtSecret;
function getJwtSecret() {
  if (jwtSecret) return jwtSecret;
  if (fs.existsSync(MASTER_KEY_PATH)) {
    jwtSecret = fs.readFileSync(MASTER_KEY_PATH, 'utf8').trim();
  } else {
    console.warn('[auth] No master key at', MASTER_KEY_PATH, '- using an ephemeral dev secret. Tokens will not survive a restart. Run provisioning/install.sh on a real box.');
    jwtSecret = require('crypto').randomBytes(32).toString('hex');
  }
  return jwtSecret;
}

async function hashPassword(password) {
  return bcrypt.hash(password, 12);
}

async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

function signToken(user) {
  return jwt.sign({ sub: user._id.toString(), email: user.email, role: user.role }, getJwtSecret(), { expiresIn: TOKEN_TTL });
}

function verifyToken(token) {
  return jwt.verify(token, getJwtSecret());
}

// Simple in-memory rate limiter for login attempts - no need for a
// dependency for this. Keyed by IP, resets after WINDOW_MS of no attempts.
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const attempts = new Map();

function isRateLimited(ip) {
  const entry = attempts.get(ip);
  if (!entry) return false;
  if (Date.now() - entry.firstAttemptAt > WINDOW_MS) {
    attempts.delete(ip);
    return false;
  }
  return entry.count >= MAX_ATTEMPTS;
}

function recordFailedAttempt(ip) {
  const entry = attempts.get(ip);
  if (!entry || Date.now() - entry.firstAttemptAt > WINDOW_MS) {
    attempts.set(ip, { count: 1, firstAttemptAt: Date.now() });
  } else {
    entry.count += 1;
  }
}

function clearAttempts(ip) {
  attempts.delete(ip);
}

async function login(email, password) {
  const users = await db.getUsersCollection();
  const user = await users.findOne({ email });
  if (!user) throw new Error('Invalid email or password');

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) throw new Error('Invalid email or password');

  return signToken(user);
}

// Express middleware - reject anything without a valid bearer token.
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing bearer token' });

  try {
    req.user = verifyToken(token);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = {
  hashPassword,
  verifyPassword,
  signToken,
  verifyToken,
  login,
  requireAuth,
  isRateLimited,
  recordFailedAttempt,
  clearAttempts
};
