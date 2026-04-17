const { createLogger } = require('../../logging/logger');

const logger = createLogger({
  level: process.env.LOG_LEVEL || 'info'
});

const systemLogger =
  typeof logger.child === 'function'
    ? logger.child({ module: 'system' })
    : logger;

module.exports = {
  logger,
  systemLogger
};
