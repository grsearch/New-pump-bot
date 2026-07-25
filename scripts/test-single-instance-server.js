'use strict';

const assert = require('assert');
const http = require('http');
const Server = require('../src/server/server');
const { config } = require('../src/config');

async function listen(server, port = 0) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

async function run() {
  const blocker = http.createServer();
  await listen(blocker);

  const originalPort = config.server.port;
  const originalHost = config.server.bindHost;
  config.server.port = blocker.address().port;
  config.server.bindHost = '127.0.0.1';

  const candidate = Object.create(Server.prototype);
  candidate.httpServer = http.createServer();

  try {
    await assert.rejects(
      candidate.start(),
      (err) =>
        err?.code === 'EADDRINUSE' &&
        err.message.includes('another bot process may already be running'),
      'a second process must fail before its trading streams start',
    );
  } finally {
    config.server.port = originalPort;
    config.server.bindHost = originalHost;
    await close(blocker);
  }

  console.log('Single-instance server test: PASS');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
