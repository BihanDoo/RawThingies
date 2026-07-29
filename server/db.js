const { MongoClient } = require('mongodb');

const url = 'mongodb://127.0.0.1:27017';
const dbName = 'raw_thingies';

let client;
let db;

async function connect() {
  if (!client) {
    client = new MongoClient(url);
    await client.connect();
    db = client.db(dbName);
  }
  return db;
}

async function getAppsCollection() {
  const database = await connect();
  return database.collection('apps');
}

async function getReleasesCollection() {
  const database = await connect();
  return database.collection('releases');
}

async function getDomainsCollection() {
  const database = await connect();
  return database.collection('domains');
}

async function getDeployLogsCollection() {
  const database = await connect();
  return database.collection('deploy_logs');
}

async function getUsersCollection() {
  const database = await connect();
  return database.collection('users');
}

async function getWebhooksCollection() {
  const database = await connect();
  return database.collection('webhooks');
}

async function close() {
  if (client) {
    await client.close();
    client = null;
  }
}

module.exports = {
  connect,
  getAppsCollection,
  getReleasesCollection,
  getDomainsCollection,
  getDeployLogsCollection,
  getUsersCollection,
  getWebhooksCollection,
  close
};
