const express = require('express');
const path = require('path');
const fs = require('fs');
const appsService = require('./apps-service');

const app = express();
app.use(express.json());

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
