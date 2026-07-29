const db = require('./db');
const appTypes = require('./app-types/registry');
const { deploy } = require('./deploy');

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

// Fires the deploy in the background and returns immediately - an HTTP request
// shouldn't have to stay open for the minutes a real deploy can take. Callers
// (the dashboard) poll listApps()/getApp() to watch `status` change.
async function triggerDeploy(name) {
  const apps = await db.getAppsCollection();
  const app = await apps.findOne({ name });
  if (!app) throw new Error(`App ${name} not found`);
  if (app.status === 'deploying') throw new Error(`App ${name} is already deploying`);

  await apps.updateOne({ name }, { $set: { status: 'deploying', updatedAt: new Date() } });

  deploy(app, { decryptedEnvVars: {} })
    .then(() => apps.updateOne({ name }, {
      $set: { status: 'running', lastDeployedAt: new Date(), lastError: null, updatedAt: new Date() }
    }))
    .catch((err) => apps.updateOne({ name }, {
      $set: { status: 'failed', lastError: err.message, updatedAt: new Date() }
    }));

  return { started: true };
}

module.exports = { createApp, listApps, getApp, triggerDeploy };
