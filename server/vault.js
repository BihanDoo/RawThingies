const crypto = require('crypto');
const fs = require('fs');

const MASTER_KEY_PATH = '/etc/raw-thingies/master.key';

let keyBuffer;
function getKey() {
  if (keyBuffer) return keyBuffer;
  if (!fs.existsSync(MASTER_KEY_PATH)) {
    throw new Error(`Master key not found at ${MASTER_KEY_PATH} - run provisioning/install.sh on this box first`);
  }
  const hex = fs.readFileSync(MASTER_KEY_PATH, 'utf8').trim();
  keyBuffer = Buffer.from(hex, 'hex');
  if (keyBuffer.length !== 32) {
    throw new Error('Master key must decode to 32 bytes for AES-256-GCM');
  }
  return keyBuffer;
}

// Layout: [12-byte IV][16-byte auth tag][ciphertext], base64-encoded as a
// single blob - matches the data model's `envVars: { encryptedBlob }`.
function encryptEnvVars(envVars) {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(envVars || {}), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

function decryptEnvVars(encryptedBlob) {
  if (!encryptedBlob) return {};
  const key = getKey();
  const data = Buffer.from(encryptedBlob, 'base64');
  const iv = data.subarray(0, 12);
  const authTag = data.subarray(12, 28);
  const ciphertext = data.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString('utf8'));
}

module.exports = { encryptEnvVars, decryptEnvVars };
