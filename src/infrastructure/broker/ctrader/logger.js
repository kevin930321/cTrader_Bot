const { createLogger } = require('../../logging/logger');

const baseLogger = createLogger({
  level: process.env.LOG_LEVEL || 'info'
});

const logger = baseLogger;
const tradeLogger = baseLogger.child({ module: 'trade' });
const apiLogger = baseLogger.child({ module: 'api' });
const systemLogger = baseLogger.child({ module: 'system' });
const auditLogger = baseLogger.child({ module: 'audit' });

function logAudit(action, details = {}) {
  auditLogger.info({
    action,
    ...details,
    timestamp: new Date().toISOString()
  });
}

module.exports = {
  logger,
  tradeLogger,
  apiLogger,
  systemLogger,
  auditLogger,
  logAudit
};
