'use strict';
require('dotenv').config();

const env = {
    str:  (key, def = '') => process.env[key] ?? def,
    num:  (key, def)      => process.env[key] ? parseFloat(process.env[key]) : def,
    bool: (key, def)      => process.env[key] === undefined ? def : ['true', '1'].includes(process.env[key]),
};

// ── 必填欄位檢查 ────────────────────────────────────────────────────────────
const REQUIRED = ['CTRADER_CLIENT_ID', 'CTRADER_CLIENT_SECRET', 'CTRADER_ACCESS_TOKEN', 'CTRADER_ACCOUNT_ID'];
const missing  = REQUIRED.filter(k => !process.env[k]);
if (missing.length) {
    console.error('❌ 缺少必要環境變數:', missing.join(', '));
    console.error('請依照 .env.example 建立 .env 檔案');
    process.exit(1);
}

const mode = env.str('CTRADER_MODE', 'demo');

module.exports = {
    ctrader: {
        clientId:     env.str('CTRADER_CLIENT_ID'),
        clientSecret: env.str('CTRADER_CLIENT_SECRET'),
        accessToken:  env.str('CTRADER_ACCESS_TOKEN'),
        refreshToken: env.str('CTRADER_REFRESH_TOKEN'),
        mode,
        accountId: env.str('CTRADER_ACCOUNT_ID'),
        host: mode === 'demo' ? 'demo.ctraderapi.com' : 'live.ctraderapi.com',
        port: 5035,
    },

    mongodb: {
        uri: env.str('MONGODB_URI', 'mongodb://localhost:27017/us30-bot'),
    },

    strategy: {
        entryOffset: env.num('ENTRY_OFFSET', 10),
        longTP:      env.num('LONG_TP', 8),
        shortTP:     env.num('SHORT_TP', 5),
        longSL:      env.num('LONG_SL', 1000),
        shortSL:     env.num('SHORT_SL', 1000),
    },

    account: {
        initialBalance: env.num('INITIAL_BALANCE', 300),
        baseLotSize:    env.num('BASE_LOT_SIZE', 0.1),
    },

    market: {
        symbol:                env.str('MARKET_SYMBOL', 'US30'),
        minsAfterOpen:         env.num('MINS_AFTER_OPEN', 1),
        baselineOffsetMinutes: env.num('BASELINE_OFFSET_MINUTES', 0),
        // 冬令 (UTC-5) → 台北 07:00，夏令 (UTC-4) → 台北 06:00
        winter: { openHour: 7, openMinute: 0 },
        summer: { openHour: 6, openMinute: 0 },
    },

    discord: {
        webhookUrl: env.str('DISCORD_WEBHOOK_URL'),
        enabled:    env.bool('DISCORD_ENABLED', true),
    },

    server: {
        port:     env.num('PORT', 3000),
        user:     env.str('DASHBOARD_USERNAME', 'admin'),
        password: env.str('DASHBOARD_PASSWORD'),
    },

    riskAgent: {
        token: env.str('RISK_AGENT_TOKEN'),
    },
};
