#!/usr/bin/env node
const db = require('../server/db');
const { deploy } = require('../server/deploy');
const { spawnSync } = require('child_process');

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log('Usage: raw <command>');
    console.log('Commands:');
    console.log('  apps list');
    console.log('  apps create --name <name> --type <type> --repo <repo> --domain <domain>');
    console.log('  deploy <name>');
    console.log('  logs <name> [--follow]');
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
        
        const apps = await db.getAppsCollection();
        const existing = await apps.findOne({ name: parsed.name });
        if (existing) {
          throw new Error(\`App \${parsed.name} already exists\`);
        }

        const newApp = {
          name: parsed.name,
          type: parsed.type,
          repoUrl: parsed.repo || null,
          branch: parsed.branch || 'main',
          domain: parsed.domain,
          config: {},
          createdAt: new Date(),
          updatedAt: new Date()
        };

        await apps.insertOne(newApp);
        console.log(\`App \${newApp.name} created successfully.\`);
      } else if (args[1] === 'list') {
        const apps = await db.getAppsCollection();
        const list = await apps.find().toArray();
        if (list.length === 0) {
          console.log('No apps found.');
        } else {
          console.table(list.map(a => ({ Name: a.name, Type: a.type, Domain: a.domain })));
        }
      } else {
        console.log(\`Unknown sub-command for apps: \${args[1]}\`);
      }
    } else if (command === 'deploy') {
      const name = args[1];
      if (!name) throw new Error('Missing app name: raw deploy <name>');
      const apps = await db.getAppsCollection();
      const app = await apps.findOne({ name });
      if (!app) throw new Error(\`App \${name} not found\`);

      // Mock context with empty environment variables for now
      // In a real flow, fetch and decrypt from vault here
      const ctx = {
        decryptedEnvVars: {}
      };

      await deploy(app, ctx);
    } else if (command === 'logs') {
      const name = args[1];
      if (!name) throw new Error('Missing app name: raw logs <name>');
      
      const parsed = parseArgs(args.slice(2));
      const pm2Args = ['logs', name];
      if (!parsed.follow) {
        pm2Args.push('--nostream');
      }
      
      spawnSync('pm2', pm2Args, { stdio: 'inherit' });
    } else {
      console.log(\`Unknown command: \${command}\`);
    }
  } catch (err) {
    console.error(\`Error: \${err.message}\`);
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
