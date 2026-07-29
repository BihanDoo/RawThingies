const { ObjectId } = require('mongodb');
const db = require('./db');
const appTypes = require('./app-types/registry');
const { deploy, rollbackTo } = require('./deploy');
const vault = require('./vault');
const webhooks = require('./webhooks');

// Decrypted only in-memory, right before use - never logged, never returned
// from an API response. See server/vault.js.
function resolveEnvVars(app) {
  return app.envVars && app.envVars.encryptedBlob ? vault.decryptEnvVars(app.envVars.encryptedBlob) : {};
}

async function setEnvVars(name, varsToMerge) {
  const apps = await db.getAppsCollection();
  const app = await apps.findOne({ name });
  if (!app) throw new Error(`App ${name} not found`);

  const merged = { ...resolveEnvVars(app), ...varsToMerge };
  const encryptedBlob = vault.encryptEnvVars(merged);
  await apps.updateOne({ name }, { $set: { envVars: { encryptedBlob }, updatedAt: new Date() } });
  return { keys: Object.keys(merged) };
}

async function createApp({ name, type, repo, branch, domain }) {
  if (!name || !type || !domain) {
    throw new Error('Missing required fields: name, type, domain');
  }

  const plugin = appTypes[type];
  if (!plugin) throw new Error(`Unknown app type: ${type}`);

  const apps = await db.getAppsCollection();
  const existing = await apps.findOne({ name });
  if (existing) throw new Error(`App ${name} already exists`);

  const newApp = {
    name,
    type,
    repoUrl: repo || null,
    branch: branch || 'main',
    domain,
    config: {},
    status: 'created',
    lastDeployedAt: null,
    lastError: null,
    createdAt: new Date(),
    updatedAt: new Date()
  };

  // One-time provisioning (e.g. port allocation) happens now, not on every deploy.
  if (plugin.provision) {
    await plugin.provision(newApp, {});
  }

  await apps.insertOne(newApp);
  return newApp;
}

async function listApps() {
  const apps = await db.getAppsCollection();
  return apps.find().sort({ createdAt: -1 }).toArray();
}

async function getApp(name) {
  const apps = await db.getAppsCollection();
  return apps.findOne({ name });
}

async function listReleases(name) {
  const apps = await db.getAppsCollection();
  const app = await apps.findOne({ name });
  if (!app) throw new Error(`App ${name} not found`);
  const releases = await db.getReleasesCollection();
  return releases.find({ appId: app._id }).sort({ deployedAt: -1 }).toArray();
}

// Runs an instrumented deploy: creates a `releases` record up front, streams
// each pipeline step into `deploy_logs`, and updates both the release and
// the app document with the outcome. Shared by the CLI (awaits this directly,
// so it blocks and shows real-time console output) and the API (fires it
// without awaiting - see triggerDeploy).
async function runDeploy(app) {
  const apps = await db.getAppsCollection();
  const releases = await db.getReleasesCollection();
  const deployLogs = await db.getDeployLogsCollection();

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const { insertedId: releaseId } = await releases.insertOne({
    appId: app._id,
    commitSha: null,
    commitMessage: null,
    releasePath: `/var/www/apps/${app.name}/releases/${timestamp}`,
    status: 'building',
    deployedAt: new Date(),
    deployedBy: null
  });

  const onLog = (stepName, output) => {
    deployLogs.insertOne({
      appId: app._id,
      releaseId,
      stepName,
      output,
      timestamp: new Date()
    }).catch((err) => console.error('[apps-service] failed to write deploy log:', err.message));
  };

  try {
    const result = await deploy(app, { decryptedEnvVars: resolveEnvVars(app), releaseTimestamp: timestamp, onLog });
    await releases.updateOne({ _id: releaseId }, {
      $set: { status: 'success', commitSha: result.commitSha || null }
    });
    await apps.updateOne({ name: app.name }, {
      $set: { status: 'running', lastDeployedAt: new Date(), lastError: null, updatedAt: new Date() }
    });
    return result;
  } catch (err) {
    await releases.updateOne({ _id: releaseId }, { $set: { status: 'failed' } });
    await apps.updateOne({ name: app.name }, {
      $set: { status: 'failed', lastError: err.message, updatedAt: new Date() }
    });
    throw err;
  }
}

// Fires the deploy in the background and returns immediately - an HTTP request
// shouldn't have to stay open for the minutes a real deploy can take. Callers
// (the dashboard) poll listApps()/getApp() to watch `status` change.
async function triggerDeploy(name) {
  const apps = await db.getAppsCollection();
  const app = await apps.findOne({ name });
  if (!app) throw new Error(`App ${name} not found`);
  if (app.status === 'deploying') throw new Error(`App ${name} is already deploying`);

  await apps.updateOne({ name }, { $set: { status: 'deploying', updatedAt: new Date() } });

  runDeploy(app).catch(() => {
    // runDeploy already persisted status/lastError - nothing further to do here,
    // just prevent this from becoming an unhandled rejection.
  });

  return { started: true };
}

// Rolls back to an already-built, previously-successful release (brief
// Section 6.3). Defaults to the most recent successful release that isn't
// the one currently live; pass releaseId to target a specific one.
async function rollbackApp(name, releaseId) {
  const apps = await db.getAppsCollection();
  const releases = await db.getReleasesCollection();
  const app = await apps.findOne({ name });
  if (!app) throw new Error(`App ${name} not found`);
  if (app.status === 'deploying') throw new Error(`App ${name} is currently deploying, try again after it finishes`);

  let target;
  if (releaseId) {
    target = await releases.findOne({ _id: new ObjectId(releaseId), appId: app._id, status: 'success' });
    if (!target) throw new Error('Release not found, or was not a successful deploy');
  } else {
    const recentSuccesses = await releases
      .find({ appId: app._id, status: 'success' })
      .sort({ deployedAt: -1 })
      .limit(2)
      .toArray();
    if (recentSuccesses.length < 2) {
      throw new Error(`No previous successful release to roll back to for ${name}`);
    }
    target = recentSuccesses[1];
  }

  await apps.updateOne({ name }, { $set: { status: 'deploying', updatedAt: new Date() } });

  try {
    await rollbackTo(app, target.releasePath, { decryptedEnvVars: resolveEnvVars(app) });
    await apps.updateOne({ name }, {
      $set: { status: 'running', lastDeployedAt: new Date(), lastError: null, updatedAt: new Date() }
    });
    return { rolledBackTo: target.releasePath };
  } catch (err) {
    await apps.updateOne({ name }, {
      $set: { status: 'failed', lastError: err.message, updatedAt: new Date() }
    });
    throw err;
  }
}

// Creates the webhook secret on first call, returns the same one on every
// call after (idempotent - the operator can safely re-fetch this to paste
// into GitHub again without invalidating what's already configured there).
async function getOrCreateWebhook(name) {
  const apps = await db.getAppsCollection();
  const app = await apps.findOne({ name });
  if (!app) throw new Error(`App ${name} not found`);

  const hooks = await db.getWebhooksCollection();
  let hook = await hooks.findOne({ appId: app._id, provider: 'github' });
  if (!hook) {
    const secret = webhooks.generateSecret();
    const { insertedId } = await hooks.insertOne({
      appId: app._id,
      provider: 'github',
      secret,
      lastTriggeredAt: null,
      createdAt: new Date()
    });
    hook = { _id: insertedId, secret };
  }

  return { url: `/webhooks/github/${name}`, secret: hook.secret };
}

// Called by the public /webhooks/github/:name route. rawBody must be the
// exact bytes GitHub sent (see server/webhooks.js) - HMAC verification
// happens before anything else, including before the payload is trusted
// enough to even parse.
async function handleGithubPush(name, rawBody, signatureHeader) {
  const apps = await db.getAppsCollection();
  const app = await apps.findOne({ name });
  if (!app) throw new Error(`App ${name} not found`);

  const hooks = await db.getWebhooksCollection();
  const hook = await hooks.findOne({ appId: app._id, provider: 'github' });
  if (!hook) throw new Error(`No webhook configured for ${name}`);

  if (!webhooks.verifySignature(hook.secret, rawBody, signatureHeader)) {
    throw new Error('Invalid webhook signature');
  }

  const payload = JSON.parse(rawBody.toString('utf8'));
  const pushedBranch = payload.ref ? payload.ref.replace('refs/heads/', '') : null;
  if (pushedBranch && app.branch && pushedBranch !== app.branch) {
    return { skipped: true, reason: `push was to ${pushedBranch}, ${name} tracks ${app.branch}` };
  }

  await hooks.updateOne({ _id: hook._id }, { $set: { lastTriggeredAt: new Date() } });
  return triggerDeploy(name);
}

module.exports = {
  createApp,
  listApps,
  getApp,
  listReleases,
  runDeploy,
  triggerDeploy,
  rollbackApp,
  setEnvVars,
  getOrCreateWebhook,
  handleGithubPush
};
