const pino = require('pino');

function createLogger(loggingConfig = {}) {
  const level = loggingConfig.level || process.env.LOG_LEVEL || 'info';
  const isProduction = (process.env.NODE_ENV || 'development') === 'production';

  return pino({
    level,
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
    transport: !isProduction
      ? {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:yyyy-mm-dd HH:MM:ss',
            ignore: 'pid,hostname'
          }
        }
      : undefined
  });
}

module.exports = {
  createLogger
};
