import { createUsageServer } from './server-app.js';

// One Codex app-server per account in the registry, started on first use.
const server = createUsageServer();

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  if (address && typeof address !== 'string') {
    console.log(JSON.stringify({ ready: true, port: address.port }));
  }
});

function shutdown(): void {
  server.close();
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
