// Supervised local runtime: one broker, optional loopback viewer. MCP and CLI
// attach as clients; this process owns the store. Does not listen on a public
// interface unless BRAIWSER_DEPLOYMENT=remote and BRAIWSER_VIEWER_ORIGIN is https.
import { createRequire } from 'node:module';
import { createOperations } from './operations.mjs';

const require = createRequire(import.meta.url);

export async function startServer({
  dataDir, host = '127.0.0.1', port = 0, deployment = 'local', publicOrigin = '',
  featureFlag = true,
} = {}) {
  if (deployment === 'remote' && !publicOrigin) {
    const err = new Error('VIEWER_UNREACHABLE: a remote deployment needs BRAIWSER_VIEWER_ORIGIN');
    err.code = 'VIEWER_UNREACHABLE';
    throw err;
  }
  const { createBroker } = require('../browser/broker');
  const { createPlaywrightDriver } = require('../browser/drivers/playwright');
  const { createBrokerSkills } = require('./skill-registry');
  const broker = createBroker({
    featureFlag,
    dataDir,
    drivers: { playwright: createPlaywrightDriver() },
    skills: createBrokerSkills(),
    appVersion: 'braiwser-server',
  });
  const { createViewerGateway } = require('../browser/viewer-gateway');
  const gateway = createViewerGateway({
    broker,
    host: deployment === 'remote' ? host : '127.0.0.1',
    port,
  });
  const baseUrl = await gateway.listen();
  if (deployment === 'remote') broker.attachViewer({ enabled: true, baseUrl: publicOrigin, deployment: 'remote' });
  return {
    broker, gateway, baseUrl,
    close: async () => { await gateway.close(); await broker.close(); },
  };
}

export { createOperations };
