const express = require('express');
const path = require('path');
const fs = require('fs');
const appsService = require('./apps-service');
const auth = require('./auth');

const app = express();
app.use(express.json());

app.post('/api/auth/login', async (req, res) => {
  const ip = req.ip;
  if (auth.isRateLimited(ip)) {
    return res.status(429).json({ error: 'Too many failed login attempts, try again later' });
  }

  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'Missing email or password' });
  }

  try {
    const token = await auth.login(email, password);
    auth.clearAttempts(ip);
    res.json({ token });
  } catch (err) {
    auth.recordFailedAttempt(ip);
    res.status(401).json({ error: err.message });
  }
});

// Everything under /api/apps requires a valid session.
app.use('/api/apps', auth.requireAuth);

app.get('/api/apps', async (req, res) => {
  try {
    res.json(await appsService.listApps());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/apps/:name', async (req, res) => {
  try {
    const found = await appsService.getApp(req.params.name);
    if (!found) return res.status(404).json({ error: `App ${req.params.name} not found` });
    res.json(found);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/apps', async (req, res) => {
  try {
    const created = await appsService.createApp(req.body);
    res.status(201).json(created);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/apps/:name/deploy', async (req, res) => {
  try {
    res.json(await appsService.triggerDeploy(req.params.name));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/apps/:name/releases', async (req, res) => {
  try {
    res.json(await appsService.listReleases(req.params.name));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Rollback is comparatively fast (symlink swap + reload + nginx, no
// clone/install/build), so unlike deploy this stays synchronous.
app.post('/api/apps/:name/rollback', async (req, res) => {
  try {
    res.json(await appsService.rollbackApp(req.params.name, req.body && req.body.releaseId));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Write-only by design - values are never returned once set (brief Section
// 10: never log/expose decrypted values). Operator re-sets if they forget.
app.post('/api/apps/:name/env', async (req, res) => {
  try {
    const vars = (req.body && req.body.vars) || {};
    if (Object.keys(vars).length === 0) {
      return res.status(400).json({ error: 'Provide at least one key/value in "vars"' });
    }
    res.json(await appsService.setEnvVars(req.params.name, vars));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Serve the built dashboard (dashboard/dist) if it's been built.
const distPath = path.join(__dirname, '..', 'dashboard', 'dist');
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
} else {
  app.get('/', (req, res) => {
    res.status(200).send('Raw Thingies API is running. Dashboard not built yet - run "npm run build" in /dashboard.');
  });
}

const PORT = process.env.PORT || 4000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Raw Thingies] API listening on 0.0.0.0:${PORT}`);
});
