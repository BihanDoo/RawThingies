const crypto = require('crypto');

function generateSecret() {
  return crypto.randomBytes(24).toString('hex');
}

// Verifies GitHub's X-Hub-Signature-256 header (brief Section 10: "verify
// GitHub/GitLab HMAC signatures before triggering a deploy"). Needs the raw
// request bytes, not the parsed JSON body - HMAC is over the exact bytes
// GitHub sent, and re-serializing parsed JSON would not reliably match.
function verifySignature(secret, rawBody, signatureHeader) {
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const expectedBuf = Buffer.from(expected);
  const givenBuf = Buffer.from(signatureHeader);
  if (expectedBuf.length !== givenBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, givenBuf);
}

module.exports = { generateSecret, verifySignature };
