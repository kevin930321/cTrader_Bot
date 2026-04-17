'use strict';

class TradingBotError extends Error {
    constructor(message, code = 'UNKNOWN', details = {}) {
        super(message);
        this.name = 'TradingBotError';
        this.code = code;
        this.details = details;
        this.timestamp = new Date();
    }
    toJSON() {
        return { name: this.name, message: this.message, code: this.code, details: this.details, timestamp: this.timestamp };
    }
}

class ConnectionError  extends TradingBotError { constructor(msg, d) { super(msg, 'CONNECTION_ERROR', d);  this.name = 'ConnectionError';  } }
class OrderError       extends TradingBotError { constructor(msg, d) { super(msg, 'ORDER_ERROR', d);       this.name = 'OrderError';       } }
class MarketDataError  extends TradingBotError { constructor(msg, d) { super(msg, 'MARKET_DATA_ERROR', d); this.name = 'MarketDataError';  } }
class ConfigError      extends TradingBotError { constructor(msg, d) { super(msg, 'CONFIG_ERROR', d);      this.name = 'ConfigError';      } }

module.exports = { TradingBotError, ConnectionError, OrderError, MarketDataError, ConfigError };
