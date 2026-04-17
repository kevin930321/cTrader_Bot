'use strict';

const EventEmitter = require('events');
const { convertLongValue, rawToRealPrice, realToRawPrice, isUsDst, API_PRICE_MULTIPLIER } = require('./utils');
const { logAudit } = require('./logger');

// ── Constants ─────────────────────────────────────────────────────────────────
const PNL_DIVISOR        = 10_000;
const VOLUME_DIVISOR     = 100;
const MONEY_DIGITS_DEF   = 2;
const TRADE_HISTORY_MAX  = 50;
const BASELINE_POLL_MS   = 30_000;
const ACCOUNT_CACHE_MS   = 300_000;
const MIN_VOLUME         = 10;    // 0.1 lots

class ExecutionEngine extends EventEmitter {

    constructor(connection, config, db) {
        super();
        this.connection = connection;
        this.config     = config;
        this.db         = db;

        // ── Strategy params (may be overridden from DB) ──────────────────────
        this.entryOffset            = config.strategy.entryOffset;
        this.longTP                 = config.strategy.longTP;
        this.shortTP                = config.strategy.shortTP;
        this.longSL                 = config.strategy.longSL;
        this.shortSL                = config.strategy.shortSL;
        this.lotSize                = config.account.baseLotSize;
        this.minsAfterOpen          = config.market.minsAfterOpen;
        this.baselineOffsetMinutes  = config.market.baselineOffsetMinutes;

        // ── Runtime state ────────────────────────────────────────────────────
        this.balance         = null;
        this.positions       = [];
        this.todayTradeDone  = false;
        this.todayOpenPrice  = null;
        this.currentPrice    = null;
        this.currentBid      = null;
        this.currentAsk      = null;
        this.isWatching      = false;
        this.isPlacingOrder  = false;
        this.tradingPaused   = false;
        this.orderFailCount  = 0;
        this.pendingSlTp     = null;
        this.lastResetDate   = null;

        // ── Statistics ───────────────────────────────────────────────────────
        this.wins              = 0;
        this.losses            = 0;
        this.trades            = [];
        this.lastReportWins    = 0;
        this.lastReportLosses  = 0;
        this.lastReportProfit  = 0;

        // ── Caches ───────────────────────────────────────────────────────────
        this.symbolCache         = {};
        this.cachedAccountInfo   = null;
        this.cachedAccountInfoTs = 0;
        this.closedPositionIds   = new Set();

        // ── Intervals ────────────────────────────────────────────────────────
        this._baselineInterval  = null;
        this.isFetchingBaseline = false;

        // ── Wire up incoming messages ────────────────────────────────────────
        this.connection.on('message', d => this._onMessage(d));
        this.connection.on('account-auth-success', () => {
            console.log('🔄 Account Auth 成功，重新訂閱報價並同步持倉...');
            this.subscribeToMarketData();
            this.reconcilePositions();
        });
    }

    // ── Init ─────────────────────────────────────────────────────────────────

    async initialize() {
        try {
            const state = await this.db.loadState();
            if (state) {
                this.wins           = state.wins   || 0;
                this.losses         = state.losses || 0;
                this.trades         = state.trades || [];
                this.todayTradeDone = state.todayTradeDone || false;
                this.lastResetDate  = state.lastResetDate  || null;
                if (state.config) this._applyConfig(state.config);
                console.log('✅ 狀態已從資料庫載入');
            }

            await this.reconcilePositions();
            this.isWatching     = false;
            this.todayOpenPrice = null;
            console.log('⏳ 等待盯盤訊號...');
            this._startBaselinePolling();
        } catch (e) {
            console.error('❌ 初始化失敗:', e);
        }
    }

    _applyConfig(c) {
        if (c.entryOffset             !== undefined) this.entryOffset            = c.entryOffset;
        if (c.longTP                  !== undefined) this.longTP                 = c.longTP;
        if (c.shortTP                 !== undefined) this.shortTP                = c.shortTP;
        if (c.longSL                  !== undefined) this.longSL                 = c.longSL;
        if (c.shortSL                 !== undefined) this.shortSL                = c.shortSL;
        if (c.lotSize                 !== undefined) this.lotSize                = c.lotSize;
        if (c.minsAfterOpen           !== undefined) this.minsAfterOpen          = c.minsAfterOpen;
        if (c.baselineOffsetMinutes   !== undefined) this.baselineOffsetMinutes  = c.baselineOffsetMinutes;
        console.log('⚙️  策略參數已恢復');
    }

    // ── Reconcile ─────────────────────────────────────────────────────────────

    async reconcilePositions() {
        try {
            const raw = await this.getOpenPositions();
            this.positions = raw.map(p => {
                const side   = p.tradeData.tradeSide;
                const isBuy  = side === 1 || side === 'BUY';
                return {
                    id:         convertLongValue(p.positionId),
                    type:       isBuy ? 'long' : 'short',
                    entryPrice: convertLongValue(p.price),
                    volume:     convertLongValue(p.tradeData?.volume ?? p.volume) / VOLUME_DIVISOR,
                    openTime:   new Date(convertLongValue(p.tradeData.openTimestamp)),
                };
            });

            if (this.positions.length) {
                console.log(`⚠️  偵測到 ${this.positions.length} 個未平倉部位`);
                this.positions.forEach(p => console.log(`   - ${p.id} | ${p.type} | ${p.openTime.toLocaleString()}`));
                await this.saveState();
            } else {
                console.log('✅ 無未平倉部位');
            }
            this.emit('positions-reconciled', this.positions);
        } catch (e) {
            console.error('❌ 狀態對賬失敗:', e);
        }
    }

    // ── Market Data ───────────────────────────────────────────────────────────

    async subscribeToMarketData() {
        try {
            const sym = await this.getSymbolInfo(this.config.market.symbol);
            if (!sym) { console.error('❌ 無法取得 Symbol 資訊，訂閱失敗'); return; }

            const msg = this.connection.proto.lookupType('ProtoOASubscribeSpotsReq').create({
                ctidTraderAccountId: parseInt(this.config.ctrader.accountId),
                symbolId: [sym.symbolId],
            });
            await this.connection.send('ProtoOASubscribeSpotsReq', msg);
            console.log(`📊 已訂閱 ${this.config.market.symbol} 報價`);
        } catch (e) {
            console.error('❌ 訂閱報價失敗:', e.message);
        }
    }

    _onMessage({ type, payload }) {
        if (type === 'ProtoOASpotEvent')      this._onSpot(payload);
        if (type === 'ProtoOAExecutionEvent') this._onExecution(payload);
    }

    _onSpot(payload) {
        const spot = this.connection.proto.lookupType('ProtoOASpotEvent').decode(payload);
        const bid  = convertLongValue(spot.bid);
        const ask  = convertLongValue(spot.ask);
        if (!bid || !ask || bid <= 0 || ask <= 0 || ask < bid) return;

        this.currentPrice = (bid + ask) / 2;
        this.currentBid   = bid;
        this.currentAsk   = ask;

        this.emit('price-update', { price: this.currentPrice, bid, ask, openPrice: this.todayOpenPrice, timestamp: Date.now() });
        this._runStrategy();
    }

    // ── Strategy ──────────────────────────────────────────────────────────────

    _runStrategy() {
        if (this.tradingPaused || !this.isWatching || this.todayTradeDone) return;
        if (!this.currentPrice || !this.todayOpenPrice) return;
        if (!this._isWithinTradingHours()) return;

        const diff      = this.currentPrice - this.todayOpenPrice;
        const offsetRaw = this.entryOffset * API_PRICE_MULTIPLIER;

        if (diff >= offsetRaw) {
            console.log(`📉 做空訊號: price(${this.currentPrice}) >= open(${this.todayOpenPrice}) + offset(${offsetRaw})`);
            this.openPosition('short');
        } else if (diff <= -offsetRaw) {
            console.log(`📈 做多訊號: price(${this.currentPrice}) <= open(${this.todayOpenPrice}) - offset(${offsetRaw})`);
            this.openPosition('long');
        }
    }

    _isWithinTradingHours() {
        const tp  = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
        const cur = tp.getHours() * 60 + tp.getMinutes();
        const dst = isUsDst(new Date());
        const open  = dst ? 6 * 60 + 30 : 7 * 60 + 30;
        const close = dst ? 5 * 60      : 6 * 60;
        return cur >= open || cur < close;
    }

    // ── Order management ──────────────────────────────────────────────────────

    async openPosition(type) {
        if (this.todayTradeDone || this.isPlacingOrder) return;
        this.isPlacingOrder = true;

        try {
            const sym = await this.getSymbolInfo(this.config.market.symbol);
            if (!sym) throw new Error('無法取得 Symbol 資訊');

            const volume = Math.max(Math.round(this.lotSize * 100), MIN_VOLUME);
            console.log(`📊 下單量: ${this.lotSize} lots = ${volume} units`);

            const openReal = rawToRealPrice(this.todayOpenPrice);
            const tpReal   = type === 'long' ? openReal + this.longTP  : openReal - this.shortTP;
            const slReal   = type === 'long' ? openReal - this.longSL  : openReal + this.shortSL;

            this.pendingSlTp = { type, stopLoss: slReal, takeProfit: tpReal };

            const order = this.connection.proto.lookupType('ProtoOANewOrderReq').create({
                ctidTraderAccountId: parseInt(this.config.ctrader.accountId),
                symbolId:   sym.symbolId,
                orderType:  1, // MARKET
                tradeSide:  type === 'long' ? 1 : 2,
                volume,
                label: 'US30_MR',
            });

            const curReal = rawToRealPrice(this.currentPrice);
            console.log(`${type === 'long' ? '📈 做多' : '📉 做空'} | Price:${curReal.toFixed(2)} | TP:${tpReal.toFixed(2)} | SL:${slReal.toFixed(2)}`);

            await this.connection.send('ProtoOANewOrderReq', order);
            console.log('📨 訂單已送出，等待成交...');

            this.emit('trade-opened', { type, price: this.currentPrice, tp: tpReal, sl: slReal, baselinePrice: openReal, positionId: null });
            logAudit('OPEN_POSITION', { type, price: curReal, volume, tp: tpReal, sl: slReal });
        } catch (e) {
            console.error('❌ 開倉失敗:', e);
            this.emit('trade-error', e);
        } finally {
            this.isPlacingOrder = false;
            this.isWatching = false;
            console.log('🔒 盯盤狀態已關閉');
        }
    }

    async closePosition(positionId) {
        const targetId = typeof positionId === 'string' ? parseInt(positionId) : positionId;
        try {
            const positions = await this.getOpenPositions();
            const pos = positions.find(p => {
                const pid = convertLongValue(p.positionId);
                return pid == targetId;
            });
            if (!pos) { console.warn(`⚠️  找不到持倉 ID: ${positionId}`); return; }

            const volume = convertLongValue(pos.tradeData?.volume ?? pos.volume);
            const msg = this.connection.proto.lookupType('ProtoOAClosePositionReq').create({
                ctidTraderAccountId: parseInt(this.config.ctrader.accountId),
                positionId: targetId,
                volume,
            });
            await this.connection.send('ProtoOAClosePositionReq', msg);
            console.log(`✅ 已平倉 ID: ${positionId}`);
        } catch (e) {
            console.error(`❌ 平倉失敗 (ID:${positionId}):`, e.message);
        }
    }

    async closeAllPositions() {
        try {
            const positions = await this.getOpenPositions();
            if (!positions.length) { console.log('ℹ️  目前無持倉'); return; }
            console.log(`📊 準備平倉 ${positions.length} 個部位...`);
            for (const p of positions) {
                await this.closePosition(convertLongValue(p.positionId));
            }
        } catch (e) {
            console.error('❌ 取得持倉失敗:', e.message);
        }
    }

    async setPositionSlTp(positionId, stopLoss, takeProfit) {
        try {
            const msg = this.connection.proto.lookupType('ProtoOAAmendPositionSLTPReq').create({
                ctidTraderAccountId: parseInt(this.config.ctrader.accountId),
                positionId,
                stopLoss,
                takeProfit,
            });
            await this.connection.send('ProtoOAAmendPositionSLTPReq', msg);
            console.log(`✅ SL/TP 已設定: TP=${takeProfit.toFixed(2)}, SL=${stopLoss.toFixed(2)}`);
        } catch (e) {
            console.error('❌ 設定 SL/TP 失敗:', e.message);
        }
    }

    // ── Execution event ───────────────────────────────────────────────────────

    _onExecution(payload) {
        const ev   = this.connection.proto.lookupType('ProtoOAExecutionEvent').decode(payload);
        const type = ev.executionType;
        console.log('📨 執行事件:', type);

        if (type === 3 || type === 'ORDER_FILLED') {
            if (ev.deal?.closePositionDetail) {
                this._onTradeClosed(ev.deal);
            } else {
                // open fill
                this.todayTradeDone = true;
                this.saveState();
                console.log('✅ 開倉成功，今日任務完成');

                if (this.pendingSlTp && ev.position) {
                    const pid = convertLongValue(ev.position.positionId);
                    this.setPositionSlTp(pid, this.pendingSlTp.stopLoss, this.pendingSlTp.takeProfit);
                    this.pendingSlTp = null;
                } else {
                    console.warn('⚠️  無法設定 SL/TP: pendingSlTp 或 position 資訊不存在');
                }
                this.reconcilePositions();
                this.emit('order-filled', ev);
            }
        } else if (type === 4 || type === 'ORDER_REJECTED') {
            const code = ev.errorCode || '原因未知';
            console.error('❌ 訂單被拒:', code);
            this.orderFailCount++;
            if (this.orderFailCount <= 3) {
                this.todayTradeDone = false;
                this.saveState();
                console.log(`🔄 已重置交易標誌 (失敗次數: ${this.orderFailCount}/3)`);
            } else {
                console.error('⛔ 連續失敗 3 次，停止今日交易');
                this.emit('trade-error', new Error(`訂單連續失敗 (已停止重試): ${code}`));
                return;
            }
            this.emit('trade-error', new Error(`訂單被拒: ${code}`));
        }
    }

    _onTradeClosed(deal) {
        const pid = convertLongValue(deal.positionId);
        if (this.closedPositionIds.has(pid)) { console.log(`⚠️  重複平倉事件 (ID:${pid})，略過`); return; }
        this.closedPositionIds.add(pid);

        const detail    = deal.closePositionDetail;
        const rawPnL    = (detail.grossProfit || 0) + (detail.swap || 0) + (detail.commission || 0);
        const netProfit = rawPnL / PNL_DIVISOR;
        const digits    = detail.moneyDigits || MONEY_DIGITS_DEF;
        const balance   = (detail.balance || 0) / Math.pow(10, digits);

        console.log(`💰 平倉 ID:${pid} | PnL:$${netProfit.toFixed(2)} | 餘額:$${balance.toFixed(2)}`);

        this.balance = balance;
        if      (netProfit > 0) this.wins++;
        else if (netProfit < 0) this.losses++;

        const record = {
            id:        pid,
            closeTime: new Date(deal.executionTimestamp),
            profit:    netProfit,
            balance,
            type: (deal.tradeSide === 1 || deal.tradeSide === 'BUY') ? 'long' : 'short',
        };
        this.trades.unshift(record);
        if (this.trades.length > TRADE_HISTORY_MAX) this.trades.pop();
        this.positions = this.positions.filter(p => p.id !== pid);

        this.saveState();
        this.emit('trade-closed', record);
        this.emit('account-update', { balance, wins: this.wins, losses: this.losses, positions: this.positions });
        logAudit('CLOSE_POSITION', { positionId: pid, profit: netProfit, balance, type: record.type });
    }

    // ── Account / Symbol ──────────────────────────────────────────────────────

    async getOpenPositions() {
        const msg = this.connection.proto.lookupType('ProtoOAReconcileReq').create({
            ctidTraderAccountId: parseInt(this.config.ctrader.accountId),
        });
        const res     = await this.connection.send('ProtoOAReconcileReq', msg);
        const payload = this.connection.proto.lookupType('ProtoOAReconcileRes').decode(res.payload);
        return payload.position || [];
    }

    async getAccountInfo() {
        if (!this.connection?.connected || !this.connection?.authenticated) {
            return (Date.now() - this.cachedAccountInfoTs < ACCOUNT_CACHE_MS) ? this.cachedAccountInfo : null;
        }
        try {
            const traderReq = this.connection.proto.lookupType('ProtoOATraderReq').create({
                ctidTraderAccountId: parseInt(this.config.ctrader.accountId),
            });
            const traderRes     = await this.connection.send('ProtoOATraderReq', traderReq);
            const traderPayload = this.connection.proto.lookupType('ProtoOATraderRes').decode(traderRes.payload);
            const digits        = traderPayload.trader.moneyDigits || MONEY_DIGITS_DEF;
            const divisor       = Math.pow(10, digits);
            const balance       = traderPayload.trader.balance / divisor;

            let usedMargin = 0, unrealizedPnL = 0;
            try {
                const positions = await this.getOpenPositions();
                for (const p of positions) {
                    const d = Math.pow(10, p.moneyDigits || digits);
                    usedMargin    += (p.usedMargin   || 0) / d;
                    unrealizedPnL += ((p.swap || 0) + (p.commission || 0)) / d;
                }
            } catch { /* ignore */ }

            const equity     = balance + unrealizedPnL;
            const freeMargin = equity - usedMargin;
            const info = { balance, equity, usedMargin, freeMargin, unrealizedPnL, leverage: traderPayload.trader.leverageInCents ? traderPayload.trader.leverageInCents / 100 : null, moneyDigits: digits };
            this.cachedAccountInfo   = info;
            this.cachedAccountInfoTs = Date.now();
            return info;
        } catch (e) {
            console.error('❌ 取得帳戶資訊失敗:', e.message);
            return (Date.now() - this.cachedAccountInfoTs < ACCOUNT_CACHE_MS) ? this.cachedAccountInfo : null;
        }
    }

    calculateRealTimeAccountInfo() {
        const balance    = this.cachedAccountInfo?.balance ?? 0;
        let unrealPnL    = 0;

        const positions = this.positions.map(pos => {
            const curReal = this.currentPrice ? rawToRealPrice(this.currentPrice) : null;
            let pnl = null;
            if (curReal && pos.volume) {
                pnl = pos.type === 'long'
                    ? (curReal - pos.entryPrice) * pos.volume
                    : (pos.entryPrice - curReal) * pos.volume;
                unrealPnL += pnl;
            }
            return { ...pos, currentPrice: curReal, pnl };
        });

        const equity     = balance + unrealPnL;
        return {
            balance, equity, unrealizedPnL: unrealPnL,
            usedMargin:  this.cachedAccountInfo?.usedMargin  || 0,
            freeMargin:  equity - (this.cachedAccountInfo?.usedMargin || 0),
            leverage:    this.cachedAccountInfo?.leverage    || null,
            positions,
        };
    }

    async getSymbolInfo(name) {
        if (this.symbolCache[name]) return this.symbolCache[name];
        console.log(`🔍 查詢 Symbol: ${name}...`);
        try {
            const req = this.connection.proto.lookupType('ProtoOASymbolsListReq').create({
                ctidTraderAccountId: parseInt(this.config.ctrader.accountId),
            });
            const res     = await this.connection.send('ProtoOASymbolsListReq', req);
            const payload = this.connection.proto.lookupType('ProtoOASymbolsListRes').decode(res.payload);

            let sym = payload.symbol.find(s => s.symbolName === name);
            if (!sym) {
                for (const c of ['US30', 'DJ30', 'Wall Street 30', 'WS30', 'US30.cash', 'DJ30.cash']) {
                    sym = payload.symbol.find(s => s.symbolName.toUpperCase().includes(c.toUpperCase()));
                    if (sym) { console.log(`✅ 自動匹配替代 Symbol: ${sym.symbolName}`); break; }
                }
            }
            if (!sym) {
                console.error(`❌ 找不到 Symbol: ${name}`);
                return null;
            }
            const info = {
                symbolId:          sym.symbolId,
                symbolName:        sym.symbolName,
                lotSize:           sym.lotSize  || 100,
                digits:            sym.digits   || 2,
                stepVolume:        sym.stepVolume || 100_000,
                minVolume:         sym.minVolume  || 100_000,
                schedule:          sym.schedule   || [],
                holidays:          sym.holiday    || [],
                scheduleTimeZone:  sym.scheduleTimeZone || 'UTC',
            };
            this.symbolCache[name] = info;
            console.log(`✅ Symbol: ${info.symbolName} (ID:${info.symbolId})`);
            return info;
        } catch (e) {
            console.error('❌ 查詢 Symbol 失敗:', e.message);
            return null;
        }
    }

    // ── Market status ─────────────────────────────────────────────────────────

    async checkMarketStatus() {
        try {
            const sym = await this.getSymbolInfo(this.config.market.symbol);
            if (!sym) return { isOpen: false, reason: 'Symbol 資訊不可用' };
            const now = new Date();
            const hol = this._checkHoliday(sym.holidays, now);
            if (hol.isHoliday) return { isOpen: false, reason: `假日: ${hol.holidayName}` };
            const sch = this._checkSchedule(sym.schedule, now);
            if (!sch) return { isOpen: false, reason: '非交易時段' };
            return { isOpen: true, reason: '市場開放' };
        } catch (e) {
            console.error('❌ 檢查市場狀態失敗:', e.message);
            return { isOpen: true, reason: '無法確認，預設開放' };
        }
    }

    _checkHoliday(holidays, now) {
        if (!holidays?.length) return { isHoliday: false };
        const msPerDay  = 86_400_000;
        const todayDays = Math.floor(now.getTime() / msPerDay);
        for (const h of holidays) {
            const hDays = convertLongValue(h.holidayDate);
            if (hDays !== todayDays) {
                // Recurring check
                if (h.isRecurring) {
                    const hDate = new Date(hDays * msPerDay);
                    if (now.getMonth() === hDate.getMonth() && now.getDate() === hDate.getDate())
                        return { isHoliday: true, holidayName: h.name };
                }
                continue;
            }
            if (h.startSecond !== undefined && h.endSecond !== undefined) {
                const sec = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
                if (sec >= h.startSecond && sec < h.endSecond)
                    return { isHoliday: true, holidayName: h.name };
            } else {
                return { isHoliday: true, holidayName: h.name };
            }
        }
        return { isHoliday: false };
    }

    _checkSchedule(schedule, now) {
        if (!schedule?.length) return true;
        const dow   = now.getDay();
        const total = dow * 86400 + now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
        return schedule.some(i => {
            const s = convertLongValue(i.startSecond);
            const e = convertLongValue(i.endSecond);
            return total >= s && total < e;
        });
    }

    // ── Baseline price ────────────────────────────────────────────────────────

    _startBaselinePolling() {
        if (this._baselineInterval) return;
        console.log('🔄 啟動基準價輪詢 (每 30 秒)...');
        this.fetchAndSetOpenPrice();
        this._baselineInterval = setInterval(() => this.fetchAndSetOpenPrice(), BASELINE_POLL_MS);
    }

    stopBaselinePricePolling() {
        if (this._baselineInterval) { clearInterval(this._baselineInterval); this._baselineInterval = null; console.log('⏹️  基準價輪詢已停止'); }
    }

    async fetchAndSetOpenPrice() {
        if (this.isFetchingBaseline) return false;
        this.isFetchingBaseline = true;
        try {
            const status = await this.checkMarketStatus();
            if (!status.isOpen) { console.log(`🚫 市場未開放: ${status.reason}`); return false; }

            // Reset baseline if we just reached baseline time
            if (this._isBaselineTimeNow() && this.todayOpenPrice !== null) {
                console.log('🔄 到達基準點時間，重新獲取...');
                this.todayOpenPrice = null;
            }

            const price = await this._fetchBaselineFromApi();
            if (price !== null) { this.todayOpenPrice = price; console.log(`📊 基準點設定: ${price}`); return true; }
            console.warn(`⚠️  尚未取得基準價，等待下次輪詢...`);
            return false;
        } finally {
            this.isFetchingBaseline = false;
        }
    }

    _isBaselineTimeNow() {
        const off    = this.baselineOffsetMinutes || 0;
        const now    = new Date();
        const isDst  = isUsDst(now);
        const cfg    = isDst ? this.config.market.summer : this.config.market.winter;
        const tp     = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
        const cur    = tp.getHours() * 60 + tp.getMinutes();
        const target = cfg.openHour * 60 + cfg.openMinute + off;
        return cur >= target && cur < target + 2;
    }

    async _fetchBaselineFromApi() {
        const off = this.baselineOffsetMinutes || 0;
        try {
            const sym = await this.getSymbolInfo(this.config.market.symbol);
            if (!sym) throw new Error('Symbol info not found');

            const now    = new Date();
            const isDst  = isUsDst(now);
            const cfg    = isDst ? this.config.market.summer : this.config.market.winter;

            // Compute open time in UTC using Taipei offset (UTC+8)
            const TAIPEI_MS   = 8 * 3600_000;
            const nowUtcMs    = now.getTime() + now.getTimezoneOffset() * 60_000;
            const nowTaipei   = new Date(nowUtcMs + TAIPEI_MS);

            const openTaipei  = new Date(nowTaipei);
            openTaipei.setHours(cfg.openHour, cfg.openMinute, 0, 0);
            if (nowTaipei < openTaipei) {
                console.warn('⚠️  當前時間早於開盤，嘗試取昨日基準點...');
                openTaipei.setDate(openTaipei.getDate() - 1);
            }

            const openUtcMs      = openTaipei.getTime() - TAIPEI_MS - openTaipei.getTimezoneOffset() * 60_000;
            const baselineUtcMs  = openUtcMs + off * 60_000;
            const baselineTaipei = new Date(baselineUtcMs);
            console.log(`📅 基準時間: ${baselineTaipei.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })} (偏移 ${off} 分)`);

            const Period = this.proto ? this.connection.proto.lookupEnum('ProtoOATrendbarPeriod') : null;
            const req    = this.connection.proto.lookupType('ProtoOAGetTrendbarsReq').create({
                ctidTraderAccountId: parseInt(this.config.ctrader.accountId),
                period:   this.connection.proto.lookupEnum('ProtoOATrendbarPeriod').values.M1,
                symbolId: sym.symbolId,
                fromTimestamp: baselineUtcMs - 60_000,
                toTimestamp:   baselineUtcMs + 300_000,
                count: 10,
            });

            const res     = await this.connection.send('ProtoOAGetTrendbarsReq', req);
            const payload = this.connection.proto.lookupType('ProtoOAGetTrendbarsRes').decode(res.payload);

            if (!payload.trendbar?.length) { console.warn('⚠️  無 K 線資料'); return null; }

            const targetMin = Math.floor(baselineUtcMs / 60_000);
            const bar       = payload.trendbar.find(b => b.utcTimestampInMinutes === targetMin);
            if (!bar) { console.warn(`⚠️  找不到目標分鐘的 K 線`); return null; }

            const low       = convertLongValue(bar.low);
            const deltaOpen = convertLongValue(bar.deltaOpen) || 0;
            return low + deltaOpen;
        } catch (e) {
            console.error('❌ 取得基準價失敗:', e.message);
            return null;
        }
    }

    // ── Daily reset ───────────────────────────────────────────────────────────

    async resetDaily(force = false) {
        const now      = new Date();
        const todayStr = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Taipei' })).toDateString();

        if (!force) {
            const state = await this.db.loadState();
            if (state?.lastResetDate === todayStr) { console.log(`ℹ️  今日 (${todayStr}) 已重置，略過`); return; }
        }

        this.todayTradeDone  = false;
        this.todayOpenPrice  = null;
        this.isWatching      = false;
        this.isPlacingOrder  = false;
        this.orderFailCount  = 0;
        this.tradingPaused   = false;
        this.pendingSlTp     = null;
        this.closedPositionIds.clear();
        this.lastResetDate   = todayStr;

        await this.saveState();
        console.log('🔄 每日狀態已重置');
    }

    async saveState() {
        try {
            await this.db.saveState({
                wins: this.wins, losses: this.losses, trades: this.trades,
                todayTradeDone: this.todayTradeDone, lastResetDate: this.lastResetDate,
                lastUpdate: new Date(),
                config: {
                    entryOffset: this.entryOffset, longTP: this.longTP, shortTP: this.shortTP,
                    longSL: this.longSL, shortSL: this.shortSL, lotSize: this.lotSize,
                    minsAfterOpen: this.minsAfterOpen, baselineOffsetMinutes: this.baselineOffsetMinutes,
                },
            });
        } catch (e) { console.error('❌ 儲存狀態失敗:', e); }
    }

    // ── Public API ────────────────────────────────────────────────────────────

    startWatching() {
        if (this.isWatching || this.todayTradeDone) return;
        this.isWatching = true;
        console.log('👀 開始盯盤');
    }

    updateConfig(c) {
        const num = (v) => parseFloat(v);
        const int = (v) => parseInt(v);
        if (c.entryOffset           !== undefined) this.entryOffset           = num(c.entryOffset);
        if (c.longTP                !== undefined) this.longTP                = num(c.longTP);
        if (c.shortTP               !== undefined) this.shortTP               = num(c.shortTP);
        if (c.longSL                !== undefined) this.longSL                = num(c.longSL);
        if (c.shortSL               !== undefined) this.shortSL               = num(c.shortSL);
        if (c.lotSize               !== undefined) this.lotSize               = num(c.lotSize);
        if (c.minsAfterOpen         !== undefined) this.minsAfterOpen         = int(c.minsAfterOpen);
        if (c.baselineOffsetMinutes !== undefined) this.baselineOffsetMinutes = int(c.baselineOffsetMinutes);
        console.log('⚙️  策略參數已更新');
        this.saveState();
    }

    getStatus() {
        const total   = this.wins + this.losses;
        const sym     = this.symbolCache[this.config.market.symbol];
        return {
            tradingPaused:  this.tradingPaused,
            balance:        this.balance,
            wins:           this.wins,
            losses:         this.losses,
            winRate:        total > 0 ? `${((this.wins / total) * 100).toFixed(1)}%` : '--',
            currentPrice:   this.currentPrice,
            openPrice:      this.todayOpenPrice,
            positions:      this.positions,
            isWatching:     this.isWatching,
            todayTradeDone: this.todayTradeDone,
            trades:         this.trades,
            symbolInfo:     sym ? { name: sym.symbolName, holidays: sym.holidays?.length || 0, schedules: sym.schedule?.length || 0 } : null,
            config: {
                entryOffset: this.entryOffset, longTP: this.longTP, shortTP: this.shortTP,
                longSL: this.longSL, shortSL: this.shortSL, lotSize: this.lotSize,
                minsAfterOpen: this.minsAfterOpen, baselineOffsetMinutes: this.baselineOffsetMinutes,
            },
        };
    }
}

module.exports = ExecutionEngine;
