const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const appTypes = require('../app-types/registry');
const nginxGen = require('./nginx');

function makeLogger(ctx) {
  return (step, msg) => {
    console.log(msg);
    if (ctx.onLog) ctx.onLog(step, msg);
  };
}

async function deploy(app, ctx) {
  const plugin = appTypes[app.type];
  if (!plugin) throw new Error(`Unknown app type: ${app.type}`);

  const log = makeLogger(ctx);
  const timestamp = ctx.releaseTimestamp || new Date().toISOString().replace(/[:.]/g, '-');
  const appBase = path.join('/var/www/apps', app.name);
  const releasesPath = path.join(appBase, 'releases');
  const sharedPath = path.join(appBase, 'shared');
  const currentPath = path.join(appBase, 'current');
  const newReleasePath = path.join(releasesPath, timestamp);

  log('start', `[Deploy] Starting deploy for ${app.name} (${app.type})`);

  try {
    // 1. Lock (In a real implementation, we'd acquire a Mongo lock here)

    // 2. Clone/fetch
    if (!fs.existsSync(appBase)) {
      fs.mkdirSync(releasesPath, { recursive: true });
      fs.mkdirSync(sharedPath, { recursive: true });
    }

    let commitSha = null;
    if (app.repoUrl) {
      log('clone', `[Deploy] Cloning repository ${app.repoUrl}...`);
      execSync(`git clone ${app.repoUrl} ${newReleasePath}`, { stdio: 'inherit' });
      if (app.branch) {
        execSync(`git checkout ${app.branch}`, { cwd: newReleasePath, stdio: 'inherit' });
      }
      try {
        commitSha = execSync('git rev-parse HEAD', { cwd: newReleasePath }).toString().trim();
      } catch {
        // best-effort only, not every repo state yields a clean rev-parse
      }
    } else {
      // e.g. brand new WordPress site
      fs.mkdirSync(newReleasePath, { recursive: true });
    }

    // 3. Symlink shared resources (e.g. .env, uploads)
    if (!fs.existsSync(path.join(sharedPath, '.env')) && ctx.decryptedEnvVars) {
      const envContent = Object.keys(ctx.decryptedEnvVars)
        .map(k => `${k}=${ctx.decryptedEnvVars[k]}`)
        .join('\n');
      fs.writeFileSync(path.join(sharedPath, '.env'), envContent);
    }

    if (fs.existsSync(path.join(sharedPath, '.env'))) {
      execSync(`ln -s ${path.join(sharedPath, '.env')} ${path.join(newReleasePath, '.env')}`);
    }

    // 4. Install
    log('install', '[Deploy] Installing dependencies...');
    await plugin.install(app, newReleasePath, ctx);

    // 5. Build
    log('build', '[Deploy] Building...');
    await plugin.build(app, newReleasePath, ctx);

    // Determine if this is a first-time start
    const isFirstDeploy = !fs.existsSync(currentPath);

    // 8. Flip current symlink (atomic swap)
    // We do this BEFORE starting PM2 so PM2 is rooted in the `current` symlink path.
    // This allows `pm2 reload` to pick up the new release seamlessly.
    log('symlink', '[Deploy] Flipping symlink to new release...');
    if (fs.existsSync(currentPath)) {
       // Atomic update requires a temporary symlink, but unlink+symlink is close enough for v1.
       fs.unlinkSync(currentPath);
    }
    fs.symlinkSync(newReleasePath, currentPath);

    // 7. Start or reload
    if (isFirstDeploy) {
      log('start-app', '[Deploy] Starting app...');
      await plugin.start(app, currentPath, ctx);
    } else {
      log('reload-app', '[Deploy] Reloading app...');
      await plugin.reload(app, ctx);
    }

    // 6/10. Health check
    log('health-check', '[Deploy] Running health check...');
    await plugin.healthCheck(app, ctx);

    // 9. Nginx Config
    log('nginx', '[Deploy] Configuring Nginx...');
    const nginxConf = nginxGen.generate(app, plugin, currentPath);
    const sitesAvail = `/etc/nginx/sites-available/${app.name}`;
    const sitesEnabled = `/etc/nginx/sites-enabled/${app.name}`;

    fs.writeFileSync(sitesAvail, nginxConf);
    if (!fs.existsSync(sitesEnabled)) {
      fs.symlinkSync(sitesAvail, sitesEnabled);
    }

    // Test nginx configuration. Needs root - sudo is scoped to exactly these
    // two commands via /etc/sudoers.d/raw-thingies (see provisioning/install.sh).
    execSync(`sudo nginx -t`, { stdio: 'inherit' });
    execSync(`sudo systemctl reload nginx`, { stdio: 'inherit' });

    log('done', '[Deploy] Deploy successful!');

    // 12. Prune old releases (Keep last 5)
    const releases = fs.readdirSync(releasesPath).sort();
    if (releases.length > 5) {
      const toRemove = releases.slice(0, releases.length - 5);
      for (const r of toRemove) {
        fs.rmSync(path.join(releasesPath, r), { recursive: true, force: true });
      }
    }

    return { releasePath: newReleasePath, timestamp, commitSha };

  } catch (err) {
    console.error(`[Deploy] Error during deploy:`, err.message);
    if (ctx.onLog) ctx.onLog('error', err.message);
    // 11. Rollback
    log('rollback', '[Deploy] Rolling back...');
    if (fs.existsSync(releasesPath)) {
      const releases = fs.readdirSync(releasesPath).sort().reverse();
      // releases[0] is the failed one, releases[1] is the previous one
      if (releases.length > 1) {
        const prevRelease = releases[1];
        log('rollback', `[Deploy] Reverting to ${prevRelease}`);
        if (fs.existsSync(currentPath)) {
          fs.unlinkSync(currentPath);
        }
        fs.symlinkSync(path.join(releasesPath, prevRelease), currentPath);

        try {
          await plugin.reload(app, ctx);
        } catch (reloadErr) {
          console.error('[Deploy] Rollback reload failed:', reloadErr.message);
        }

        // Rollback nginx config if we had a backup (skipped for brevity, but needed in a robust impl)
        try {
          execSync(`sudo systemctl reload nginx`, { stdio: 'inherit' });
        } catch (nginxErr) {
          console.error('[Deploy] Rollback nginx reload failed:', nginxErr.message);
        }
      }
    } else {
      // Failed before the releases dir was even created (e.g. permission error) - nothing to roll back to.
      log('rollback', '[Deploy] No releases directory yet, nothing to roll back to.');
    }
    throw err;
  }
}

// Explicit rollback to an already-built release (brief Section 6.3: "rollback
// is not special-cased, it's deploy an already-built release"). Reuses the
// same symlink-swap / reload / nginx steps as a normal deploy's cutover.
async function rollbackTo(app, releasePath, ctx) {
  const plugin = appTypes[app.type];
  if (!plugin) throw new Error(`Unknown app type: ${app.type}`);

  const log = makeLogger(ctx);

  if (!fs.existsSync(releasePath)) {
    throw new Error(`Release path no longer exists on disk: ${releasePath}`);
  }

  const appBase = path.join('/var/www/apps', app.name);
  const currentPath = path.join(appBase, 'current');

  log('rollback', `[Rollback] Pointing current -> ${releasePath}`);
  if (fs.existsSync(currentPath)) {
    fs.unlinkSync(currentPath);
  }
  fs.symlinkSync(releasePath, currentPath);

  log('rollback', '[Rollback] Reloading app...');
  await plugin.reload(app, ctx);

  log('rollback', '[Rollback] Running health check...');
  await plugin.healthCheck(app, ctx);

  log('rollback', '[Rollback] Configuring Nginx...');
  const nginxConf = nginxGen.generate(app, plugin, currentPath);
  const sitesAvail = `/etc/nginx/sites-available/${app.name}`;
  const sitesEnabled = `/etc/nginx/sites-enabled/${app.name}`;
  fs.writeFileSync(sitesAvail, nginxConf);
  if (!fs.existsSync(sitesEnabled)) {
    fs.symlinkSync(sitesAvail, sitesEnabled);
  }
  execSync(`sudo nginx -t`, { stdio: 'inherit' });
  execSync(`sudo systemctl reload nginx`, { stdio: 'inherit' });

  log('rollback', '[Rollback] Done.');
}

module.exports = { deploy, rollbackTo };
