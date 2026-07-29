#!/usr/bin/env node
const db = require('../server/db');
const appsService = require('../server/apps-service');
const auth = require('../server/auth');
const { spawnSync } = require('child_process');

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log('Usage: raw <command>');
    console.log('Commands:');
    console.log('  apps list');
    console.log('  apps create --name <name> --type <type> --repo <repo> --domain <domain>');
    console.log('  deploy <name>');
    console.log('  rollback <name> [--release <id>]');
    console.log('  logs <name> [--follow]');
    console.log('  admin create --email <email> --password <password>');
    console.log('  env set <name> KEY=value [KEY2=value2 ...]');
    process.exit(1);
  }

  const command = args[0];

  try {
    if (command === 'apps') {
      if (args[1] === 'create') {
        const parsed = parseArgs(args.slice(2));
        if (!parsed.name || !parsed.type || !parsed.domain) {
          throw new Error('Missing required arguments: --name, --type, --domain');
        }

        const newApp = await appsService.createApp({
          name: parsed.name,
          type: parsed.type,
          repo: parsed.repo,
          branch: parsed.branch,
          domain: parsed.domain
        });
        console.log(`App ${newApp.name} created successfully.`);
      } else if (args[1] === 'list') {
        const list = await appsService.listApps();
        if (list.length === 0) {
          console.log('No apps found.');
        } else {
          console.table(list.map(a => ({ Name: a.name, Type: a.type, Domain: a.domain, Status: a.status })));
        }
      } else {
        console.log(`Unknown sub-command for apps: ${args[1]}`);
      }
    } else if (command === 'deploy') {
      const name = args[1];
      if (!name) throw new Error('Missing app name: raw deploy <name>');
      const app = await appsService.getApp(name);
      if (!app) throw new Error(`App ${name} not found`);

      await appsService.runDeploy(app);
      console.log(`Deploy of ${name} succeeded.`);
    } else if (command === 'rollback') {
      const name = args[1];
      if (!name) throw new Error('Missing app name: raw rollback <name> [--release <id>]');
      const parsed = parseArgs(args.slice(2));

      const result = await appsService.rollbackApp(name, parsed.release);
      console.log(`Rolled back ${name} to ${result.rolledBackTo}`);
    } else if (command === 'logs') {
      const name = args[1];
      if (!name) throw new Error('Missing app name: raw logs <name>');

      const parsed = parseArgs(args.slice(2));
      const pm2Args = ['logs', name];
      if (!parsed.follow) {
        pm2Args.push('--nostream');
      }

      spawnSync('pm2', pm2Args, { stdio: 'inherit' });
    } else if (command === 'env') {
      if (args[1] === 'set') {
        const name = args[2];
        if (!name) throw new Error('Missing app name: raw env set <name> KEY=value ...');
        const pairs = args.slice(3);
        if (pairs.length === 0) throw new Error('Provide at least one KEY=value pair');

        const varsToMerge = {};
        for (const pair of pairs) {
          const eq = pair.indexOf('=');
          if (eq === -1) throw new Error(`Invalid KEY=value pair: ${pair}`);
          varsToMerge[pair.slice(0, eq)] = pair.slice(eq + 1);
        }

        const result = await appsService.setEnvVars(name, varsToMerge);
        console.log(`Set ${Object.keys(varsToMerge).join(', ')} for ${name}. App now has ${result.keys.length} env var(s) total.`);
      } else {
        console.log(`Unknown sub-command for env: ${args[1]}`);
      }
    } else if (command === 'admin') {
      if (args[1] === 'create') {
        const parsed = parseArgs(args.slice(2));
        if (!parsed.email || !parsed.password) {
          throw new Error('Missing required arguments: --email, --password');
        }

        const users = await db.getUsersCollection();
        const existing = await users.findOne({ email: parsed.email });
        if (existing) throw new Error(`User ${parsed.email} already exists`);

        const passwordHash = await auth.hashPassword(parsed.password);
        await users.insertOne({ email: parsed.email, passwordHash, role: 'admin', createdAt: new Date() });
        console.log(`Admin user ${parsed.email} created.`);
      } else {
        console.log(`Unknown sub-command for admin: ${args[1]}`);
      }
    } else {
      console.log(`Unknown command: ${command}`);
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
  } finally {
    await db.close();
  }
}

// Simple flag parser
function parseArgs(args) {
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      const val = args[i + 1];
      if (val && !val.startsWith('--')) {
        parsed[key] = val;
        i++;
      } else {
        parsed[key] = true;
      }
    }
  }
  return parsed;
}

main();
