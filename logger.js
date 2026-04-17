'use strict';

const pino = require('pino');

const isDev = process.env.NODE_ENV !== 'production';

const logger = pino({
    level: process.env.LOG_LEVEL || 'info',
    transport: isDev ? {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:yyyy-mm-dd HH:MM:ss', ignore: 'pid,hostname' },
    } : undefined,
});

const tradeLogger  = logger.child({ module: 'trade'  });
const apiLogger    = logger.child({ module: 'api'    });
const systemLogger = logger.child({ module: 'system' });
const auditLogger  = logger.child({ module: 'audit'  });

function logAudit(action, details = {}) {
    auditLogger.info({ action, ...details, timestamp: new Date().toISOString() });
}

module.exports = { logger, tradeLogger, apiLogger, systemLogger, auditLogger, logAudit };
