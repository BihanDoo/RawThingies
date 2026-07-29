const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const appTypes = require('../app-types/registry');
const nginxGen = require('./nginx');

async function deploy(app, ctx) {
  const plugin = appTypes[app.type];
  if (!plugin) throw new Error(`Unknown app type: ${app.type}`);

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const appBase = path.join('/var/www/apps', app.name);
  const releasesPath = path.join(appBase, 'releases');
  const sharedPath = path.join(appBase, 'shared');
  const currentPath = path.join(appBase, 'current');
  const newReleasePath = path.join(releasesPath, timestamp);

  console.log(`[Deploy] Starting deploy for ${app.name} (${app.type})`);

  try {
    // 1. Lock (In a real implementation, we'd acquire a Mongo lock here)

    // 2. Clone/fetch
    if (!fs.existsSync(appBase)) {
      fs.mkdirSync(releasesPath, { recursive: true });
      fs.mkdirSync(sharedPath, { recursive: true });
    }

    if (app.repoUrl) {
      console.log(`[Deploy] Cloning repository ${app.repoUrl}...`);
      execSync(`git clone ${app.repoUrl} ${newReleasePath}`, { stdio: 'inherit' });
      if (app.branch) {
        execSync(`git checkout ${app.branch}`, { cwd: newReleasePath, stdio: 'inherit' });
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
    console.log('[Deploy] Installing dependencies...');
    await plugin.install(app, newReleasePath, ctx);

    // 5. Build
    console.log('[Deploy] Building...');
    await plugin.build(app, newReleasePath, ctx);

    // Determine if this is a first-time start
    const isFirstDeploy = !fs.existsSync(currentPath);

    // 8. Flip current symlink (atomic swap)
    // We do this BEFORE starting PM2 so PM2 is rooted in the `current` symlink path.
    // This allows `pm2 reload` to pick up the new release seamlessly.
    console.log('[Deploy] Flipping symlink to new release...');
    if (fs.existsSync(currentPath)) {
       // Atomic update requires a temporary symlink, but unlink+symlink is close enough for v1.
       fs.unlinkSync(currentPath);
    }
    fs.symlinkSync(newReleasePath, currentPath);

    // 7. Start or reload
    if (isFirstDeploy) {
      console.log('[Deploy] Starting app...');
      await plugin.start(app, currentPath, ctx);
    } else {
      console.log('[Deploy] Reloading app...');
      await plugin.reload(app, ctx);
    }

    // 6/10. Health check
    console.log('[Deploy] Running health check...');
    await plugin.healthCheck(app, ctx);

    // 9. Nginx Config
    console.log('[Deploy] Configuring Nginx...');
    const nginxConf = nginxGen.generate(app, plugin, currentPath);
    const sitesAvail = `/etc/nginx/sites-available/${app.name}`;
    const sitesEnabled = `/etc/nginx/sites-enabled/${app.name}`;

    fs.writeFileSync(sitesAvail, nginxConf);
    if (!fs.existsSync(sitesEnabled)) {
      fs.symlinkSync(sitesAvail, sitesEnabled);
    }

    // Test nginx configuration
    execSync(`nginx -t`, { stdio: 'inherit' });
    execSync(`systemctl reload nginx`, { stdio: 'inherit' });

    console.log('[Deploy] Deploy successful!');

    // 12. Prune old releases (Keep last 5)
    const releases = fs.readdirSync(releasesPath).sort();
    if (releases.length > 5) {
      const toRemove = releases.slice(0, releases.length - 5);
      for (const r of toRemove) {
        fs.rmSync(path.join(releasesPath, r), { recursive: true, force: true });
      }
    }

  } catch (err) {
    console.error(`[Deploy] Error during deploy:`, err.message);
    // 11. Rollback
    console.log('[Deploy] Rolling back...');
    if (fs.existsSync(releasesPath)) {
      const releases = fs.readdirSync(releasesPath).sort().reverse();
      // releases[0] is the failed one, releases[1] is the previous one
      if (releases.length > 1) {
        const prevRelease = releases[1];
        console.log(`[Deploy] Reverting to ${prevRelease}`);
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
          execSync(`systemctl reload nginx`, { stdio: 'inherit' });
        } catch (nginxErr) {
          console.error('[Deploy] Rollback nginx reload failed:', nginxErr.message);
        }
      }
    } else {
      // Failed before the releases dir was even created (e.g. permission error) - nothing to roll back to.
      console.log('[Deploy] No releases directory yet, nothing to roll back to.');
    }
    throw err;
  }
}

module.exports = { deploy };
