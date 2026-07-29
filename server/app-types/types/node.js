const pm2 = require('pm2');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');

function buildEnv(app, ctx) {
  return {
    ...ctx.decryptedEnvVars,
    PORT: app.config.port,
    NODE_ENV: 'production'
  };
}

function startProcess(app, releasePath, ctx) {
  return new Promise((resolve, reject) => {
    const sharedPath = path.join('/var/www/apps', app.name, 'shared');
    const startCommand = app.config.startCommand || 'npm start';

    const logsDir = path.join(sharedPath, 'logs');
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }

    pm2.start({
      name: app.name,
      script: startCommand,
      cwd: releasePath,
      // 'cluster' mode requires a real Node entry file it can require()
      // internally - it can't cluster an arbitrary npm/yarn wrapper command.
      // 'fork' works with any start command and is what config.startCommand
      // (default 'npm start') actually needs.
      exec_mode: 'fork',
      instances: 1,
      env: buildEnv(app, ctx),
      max_memory_restart: '512M',
      out_file: path.join(logsDir, 'out.log'),
      error_file: path.join(logsDir, 'error.log'),
    }, (err, proc) => {
      if (err) return reject(err);
      resolve(proc);
    });
  });
}

module.exports = {
  id: 'node',

  detect(repoPath) {
    return fs.existsSync(path.join(repoPath, 'package.json'));
  },

  async provision(app, ctx) {
    // Initialize config if it doesn't exist
    if (!app.config) app.config = {};

    // Assign a default port if not provided (Simplistic allocation for now)
    if (!app.config.port) {
      // Find a port between 3000 and 4000 based on some deterministic or random way.
      // In a real app, this should query the DB for used ports to ensure no collision.
      app.config.port = 3000 + Math.floor(Math.random() * 1000);
    }
  },

  async install(app, releasePath, ctx) {
    const pkgPath = path.join(releasePath, 'package.json');
    if (fs.existsSync(pkgPath)) {
      if (fs.existsSync(path.join(releasePath, 'package-lock.json'))) {
        execSync('npm ci', { cwd: releasePath, stdio: 'pipe' });
      } else {
        execSync('npm install', { cwd: releasePath, stdio: 'pipe' });
      }
    }
  },

  async build(app, releasePath, ctx) {
    const pkgPath = path.join(releasePath, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (pkg.scripts && pkg.scripts.build) {
        execSync('npm run build', { cwd: releasePath, stdio: 'pipe' });
      }
    }
  },

  async start(app, releasePath, ctx) {
    return new Promise((resolve, reject) => {
      pm2.connect((err) => {
        if (err) return reject(err);
        startProcess(app, releasePath, ctx)
          .then((proc) => { pm2.disconnect(); resolve(proc); })
          .catch((err) => { pm2.disconnect(); reject(err); });
      });
    });
  },

  // PM2's reload()/restart() do NOT pick up new env vars by default - PM2
  // keeps whatever env the process was originally pm2.start()'d with, and
  // passing a fresh `env` object to restart() requires an ecosystem.config
  // file (throws "Using --env [env] without passing the ecosystem.config.js
  // does not work" otherwise - confirmed by actually hitting it). So instead
  // of fighting PM2's updateEnv semantics, just delete + start fresh with
  // the current env - simple, predictable, and reuses the exact same path
  // that already works for first deploys. `current` already points at the
  // new release by the time this is called (deploy/index.js flips the
  // symlink before calling start/reload).
  async reload(app, ctx) {
    const currentPath = path.join('/var/www/apps', app.name, 'current');
    return new Promise((resolve, reject) => {
      pm2.connect((err) => {
        if (err) return reject(err);
        pm2.delete(app.name, () => {
          // Ignore delete errors (e.g. process didn't exist) - proceed regardless.
          startProcess(app, currentPath, ctx)
            .then((proc) => { pm2.disconnect(); resolve(proc); })
            .catch((err) => { pm2.disconnect(); reject(err); });
        });
      });
    });
  },

  async stop(app, ctx) {
    return new Promise((resolve, reject) => {
      pm2.connect((err) => {
        if (err) return reject(err);
        pm2.stop(app.name, (err) => {
          pm2.disconnect();
          if (err) return reject(err);
          resolve();
        });
      });
    });
  },

  async healthCheck(app, ctx) {
    const port = app.config.port;
    const checkPath = app.healthCheckPath || '/';

    // Retry logic since the app might take a few seconds to bind
    let retries = 5;

    const tryFetch = () => {
      return new Promise((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${port}${checkPath}`, (res) => {
          if (res.statusCode >= 200 && res.statusCode < 400) {
            resolve(true);
          } else {
            reject(new Error(`Health check failed with status ${res.statusCode}`));
          }
        });
        req.on('error', (e) => reject(e));
        req.setTimeout(2000, () => {
          req.destroy();
          reject(new Error('Health check timed out'));
        });
      });
    };

    while (retries > 0) {
      try {
        await tryFetch();
        return true;
      } catch (err) {
        retries--;
        if (retries === 0) throw err;
        // Wait 2s before retry
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  },

  nginxConfig(app) {
    return `
location / {
    proxy_pass http://127.0.0.1:${app.config.port};
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection 'upgrade';
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
`;
  }
};
