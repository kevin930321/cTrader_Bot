'use strict';

const cron     = require('node-cron');
const https    = require('https');
const http     = require('http');
const express  = require('express');
const path     = require('path');
const { Server } = require('socket.io');

const config          = require('./config');
const CTraderConnection = require('./CTraderConnection');
const ExecutionEngine = require('./ExecutionEngine');
const db              = require('./db');
const TokenManager    = require('./tokenManager');
const { isUsDst, rawToRealPrice } = require('./utils');

// ── In-memory log ring buffer ─────────────────────────────────────────────────
const MAX_LOGS = 100;
const logs     = [];
let   io       = null;

const _origLog = console.log.bind(console);
console.log = (...args) => {
    const ts  = new Date().toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });
    const msg = `[${ts}] ${args.join(' ')}`;
    logs.unshift(msg);
    if (logs.length > MAX_LOGS) logs.pop();
    _origLog(...args);
    if (io) io.emit('new-log', msg);
};

// ═══════════════════════════════════════════════════════════════════════════════
class TradingBot {

    constructor() {
        this.connection   = null;
        this.engine       = null;
        this.tokenManager = null;
        this.lastResetDate = null;
        console.log('🤖 US30 交易機器人初始化...');
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    async init() {
        // 1. Token
        this.tokenManager = new TokenManager(config);
        await this.tokenManager.checkAndRefresh();
        this.tokenManager.startAutoRefresh();

        // 2. Connection
        this.connection = new CTraderConnection(config, this.tokenManager);
        this.connection.on('app-auth-success', async () => {
            console.log('🔄 App Auth 成功，進行 Account Auth...');
            try { await this.connection.sendAccountAuth(); }
            catch (e) { console.error('❌ Account Auth 失敗:', e.message); }
        });
        await this.connection.connect();

        // 3. Engine
        this.engine = new ExecutionEngine(this.connection, config, db);
        await this.engine.initialize();
        this.lastResetDate = this.engine.lastResetDate;

        this._bindEvents();
        console.log('✅ 機器人初始化完成');
    }

    async stop() {
        this.engine?.stopBaselinePricePolling();
        this.connection?.disconnect();
        this.tokenManager?.stopAutoRefresh();
        console.log('🛑 機器人已停止');
    }

    // ── Scheduling ────────────────────────────────────────────────────────────

    start() {
        const t   = this._watchTime();
        const sea = t.isDst ? '夏令' : '冬令';
        console.log(`🚀 機器人啟動，目前美股${sea}，等待 ${t.hour}:${String(t.minute).padStart(2,'0')} 盯盤...`);
        cron.schedule('* * * * *', () => this._tick());
    }

    _watchTime() {
        const now = new Date();
        const dst = isUsDst(now);
        const cfg = dst ? config.market.summer : config.market.winter;
        const mins = cfg.openMinute + (this.engine?.minsAfterOpen ?? config.market.minsAfterOpen);
        return { hour: cfg.openHour + Math.floor(mins / 60), minute: mins % 60, isDst: dst };
    }

    async _tick() {
        // ── Connection watchdog ──────────────────────────────────────────────
        if (this.connection && !this.connection.connected && !this.connection.reconnectTimer) {
            console.log('🐕 看門狗偵測到斷線，嘗試恢復...');
            this.connection.connect().catch(e => console.error('看門狗重連失敗:', e.message));
        }

        const t   = this._watchTime();
        const dst = t.isDst;
        const tp  = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
        const hr  = tp.getHours(), min = tp.getMinutes(), dow = tp.getDay();
        const today = tp.toDateString();

        // ── Daily reset ──────────────────────────────────────────────────────
        if (this.lastResetDate !== today) {
            const isWknd = dow === 0 || dow === 6;
            let statusStr = isWknd ? '週末' : '交易日';
            if (this.engine && this.connection?.connected) {
                try {
                    const s = await this.engine.checkMarketStatus();
                    if (!s.isOpen) statusStr = s.reason;
                } catch { /* ignore */ }
            }
            const sea = dst ? '夏令' : '冬令';
            console.log(`📅 新日期: ${today} (${statusStr}, 美股${sea})`);

            if (this.engine) {
                await this.engine.resetDaily();
                this.lastResetDate = today;
                if (!isWknd) { console.log('🔄 新交易日，嘗試取得基準點...'); this.engine.fetchAndSetOpenPrice(); }
            }
        }

        // ── Watch trigger ────────────────────────────────────────────────────
        const isWknd     = dow === 0 || dow === 6;
        const isWatchTime = hr === t.hour && min === t.minute;
        if (isWknd || !isWatchTime || !this.engine || this.engine.todayTradeDone || this.engine.isWatching) return;

        const ms = await this.engine.checkMarketStatus();
        if (!ms.isOpen) { console.log(`🚫 市場休市: ${ms.reason}，跳過盯盤`); return; }

        console.log(`⏰ ${t.hour}:${String(t.minute).padStart(2,'0')} 觸發盯盤！`);
        this.engine.startWatching();
    }

    // ── Events → Socket.IO / Discord ──────────────────────────────────────────

    _bindEvents() {
        const { engine, connection } = this;

        engine.on('trade-opened', d => io?.emit('trade-opened', d));

        engine.on('trade-closed', trade => {
            io?.emit('trade-closed', trade);
            const total = engine.wins + engine.losses;
            if (total > 0 && total % 10 === 0) {
                const pw = engine.wins   - engine.lastReportWins;
                const pl = engine.losses - engine.lastReportLosses;
                const tp = pw + pl;
                const totalProfit  = engine.trades.reduce((s, t) => s + (t.profit || 0), 0);
                const periodProfit = totalProfit - engine.lastReportProfit;
                const from = total - 9, to = total;
                this._discord(
                    `📊 **第 ${from}-${to} 次結算報告**\n` +
                    `✅ 本期勝率: ${tp > 0 ? ((pw/tp)*100).toFixed(1) : '0.0'}% (${pw}勝/${pl}敗)\n` +
                    `💰 本期損益: $${periodProfit.toFixed(2)}\n` +
                    `📈 累計勝率: ${total > 0 ? ((engine.wins/total)*100).toFixed(1) : '--'}% (${engine.wins}勝/${engine.losses}敗)\n` +
                    `💵 當前餘額: $${engine.balance?.toFixed(2) || '--'}`
                );
                engine.lastReportWins   = engine.wins;
                engine.lastReportLosses = engine.losses;
                engine.lastReportProfit = totalProfit;
            }
        });

        engine.on('trade-error', e => this._discord(`❌ 交易錯誤: ${e.message}`));
        connection.on('reconnect-failed', () => this._discord('⚠️ cTrader 重連失敗，請檢查連線'));

        // Price throttle → realtime-update
        let lastPush = 0;
        engine.on('price-update', data => {
            if (!io || Date.now() - lastPush < 500) return;
            lastPush = Date.now();
            const info = engine.calculateRealTimeAccountInfo();
            io.emit('realtime-update', {
                ...data, currentPrice: data.price, ...info,
                isWatching: engine.isWatching, tradingPaused: engine.tradingPaused,
                todayTradeDone: engine.todayTradeDone,
                wins: engine.wins, losses: engine.losses,
                winRate: engine.wins + engine.losses > 0
                    ? `${((engine.wins / (engine.wins + engine.losses)) * 100).toFixed(1)}%` : '--',
            });
        });

        engine.on('account-update',        d => io?.emit('account-update', d));
        engine.on('positions-reconciled',  p => io?.emit('positions-update', { positions: p }));
    }

    // ── Discord ───────────────────────────────────────────────────────────────

    _discord(msg) {
        if (!config.discord.webhookUrl || !config.discord.enabled) return;
        const url  = new URL(config.discord.webhookUrl);
        const body = JSON.stringify({ content: msg });
        const req  = https.request({
            hostname: url.hostname, path: url.pathname, method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        }, res => { if (res.statusCode !== 204) console.error('Discord 通知失敗:', res.statusCode); });
        req.on('error', e => console.error('Discord 錯誤:', e.message));
        req.write(body); req.end();
    }

    // ── Status ────────────────────────────────────────────────────────────────

    getStatus() {
        if (!this.engine) return { connected: false, message: '引擎未初始化' };
        return { connected: this.connection?.connected || false, authenticated: this.connection?.authenticated || false, ...this.engine.getStatus() };
    }

    async getDailyReset()  { if (this.engine) await this.engine.resetDaily(); }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Express / Socket.IO setup
// ═══════════════════════════════════════════════════════════════════════════════

const bot = new TradingBot();
const app = express();

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Basic Auth middleware ─────────────────────────────────────────────────────
const { user: DASH_USER, password: DASH_PASS } = config.server;

app.use((req, res, next) => {
    if (req.path === '/health') return next();
    if (!DASH_PASS) return next();
    const auth = req.headers.authorization;
    if (!auth) { res.set('WWW-Authenticate', 'Basic realm="US30 Dashboard"'); return res.status(401).send('需要登入'); }
    const [u, p] = Buffer.from(auth.split(' ')[1], 'base64').toString().split(':');
    if (u === DASH_USER && p === DASH_PASS) return next();
    res.set('WWW-Authenticate', 'Basic realm="US30 Dashboard"');
    return res.status(401).send('帳號或密碼錯誤');
});

if (DASH_PASS) console.log('🔐 Dashboard 已啟用密碼保護');
else           console.warn('⚠️  Dashboard 未設定密碼');

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => res.json({ status: 'ok', connected: bot.connection?.connected || false, timestamp: new Date().toISOString() }));

app.get('/api/status', async (_req, res) => {
    try {
        const status = bot.getStatus();
        if (bot.engine && bot.connection?.connected) {
            try {
                const info = await bot.engine.getAccountInfo();
                if (info) Object.assign(status, { balance: info.balance, equity: info.equity, usedMargin: info.usedMargin, freeMargin: info.freeMargin, unrealizedPnL: info.unrealizedPnL, leverage: info.leverage });
            } catch { /* use cached */ }
        }
        res.json({ ...status, logs });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/action', async (req, res) => {
    const { action } = req.body;
    console.log(`收到操作: ${action}`);
    try {
        switch (action) {
            case 'reset':          await bot.getDailyReset(); break;
            case 'toggleWatch':    if (bot.engine) bot.engine.isWatching = !bot.engine.isWatching; break;
            case 'closePositions': if (bot.engine) await bot.engine.closeAllPositions(); break;
            case 'closePosition':  if (bot.engine && req.body.positionId) await bot.engine.closePosition(req.body.positionId); break;
            case 'updateConfig':   if (bot.engine && req.body.config) bot.engine.updateConfig(req.body.config); break;
            case 'togglePause':
                if (bot.engine) { bot.engine.tradingPaused = !bot.engine.tradingPaused; console.log(`⏸️  交易${bot.engine.tradingPaused ? '已暫停' : '已繼續'}`); }
                break;
            case 'fetchOpenPrice':
                if (bot.engine) {
                    const ok = await bot.engine.fetchAndSetOpenPrice();
                    if (!ok) return res.json({ success: false, message: '無法取得基準點', state: bot.getStatus() });
                }
                break;
        }
        res.json({ success: true, state: bot.getStatus() });
    } catch (e) { console.error('API Error:', e); res.status(500).json({ error: e.message }); }
});

// Risk Agent API
app.post('/api/risk/modify', async (req, res) => {
    const { token, positionId, takeProfit, stopLoss } = req.body;
    if (token !== config.riskAgent.token) return res.status(403).json({ error: 'Unauthorized' });
    if (!bot.engine)                      return res.status(503).json({ error: 'Engine not ready' });

    try {
        let sl = stopLoss, tp = takeProfit;
        if (sl === undefined || tp === undefined) {
            const positions = await bot.engine.getOpenPositions();
            const pos       = positions.find(p => convertLongValue(p.positionId) == positionId);
            if (!pos) return res.status(404).json({ error: 'Position not found' });
            if (sl === undefined && pos.stopLoss) sl = rawToRealPrice(pos.stopLoss);
        }
        if (sl === undefined || tp === undefined) return res.status(400).json({ error: 'Missing SL or TP' });
        await bot.engine.setPositionSlTp(positionId, sl, tp);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));

// ── HTTP + Socket.IO ──────────────────────────────────────────────────────────

const server = http.createServer(app);
io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

io.on('connection', socket => {
    console.log('🔌 Dashboard 客戶端連線');
    const status = bot.getStatus();
    if (bot.engine) {
        const info = bot.engine.calculateRealTimeAccountInfo();
        socket.emit('initial-state', { ...status, ...info });
    }
    socket.on('disconnect', () => console.log('🔌 Dashboard 客戶端斷開'));
});

// ── Status cron ───────────────────────────────────────────────────────────────
cron.schedule('0,30 * * * * *', async () => {
    const s = bot.getStatus();
    if (!s.connected) return;
    let bal = s.balance;
    if (bot.engine && bot.connection?.connected && bot.connection?.authenticated) {
        try { const i = await bot.engine.getAccountInfo(); if (i) bal = i.balance; } catch { /* ignore */ }
    }
    console.log(`📊 餘額=$${bal?.toFixed(2)||0} | 勝率=${s.winRate} | 盯盤=${s.isWatching?'是':'否'} | 今日完成=${s.todayTradeDone?'是':'否'}`);
});

// ── Signals ───────────────────────────────────────────────────────────────────
const shutdown = (sig) => {
    console.log(`\n👋 收到 ${sig}，關閉中...`);
    bot.stop();
    process.exit(0);
};
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ── Boot ──────────────────────────────────────────────────────────────────────
const PORT = config.server.port;
server.listen(PORT, () => {
    console.log(`🌐 Dashboard 啟動於 http://localhost:${PORT}`);
    console.log(`🔌 Socket.IO 即時推送已啟用`);
});

(async () => {
    try {
        await bot.init();
        bot.start();
    } catch (e) {
        console.error('❌ 機器人啟動失敗:', e.message);
        process.exit(1);
    }
})();

module.exports = bot;
