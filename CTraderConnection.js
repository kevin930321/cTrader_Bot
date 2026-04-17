'use strict';

const tls          = require('tls');
const protobuf     = require('protobufjs');
const path         = require('path');
const EventEmitter = require('events');

// ── Tunables ──────────────────────────────────────────────────────────────────
const CONNECT_TIMEOUT_MS  =  10_000;
const REQUEST_TIMEOUT_MS  =  30_000;
const HEARTBEAT_INTERVAL  =  10_000;
const HEARTBEAT_TIMEOUT   =  30_000;
const MAX_RECONNECT_DELAY =  60_000;
const MAX_PACKET_BYTES    = 1_048_576; // 1 MB

const PROTO_FILES = [
    'OpenApiCommonMessages.proto',
    'OpenApiCommonModelMessages.proto',
    'OpenApiMessages.proto',
    'OpenApiModelMessages.proto',
].map(f => path.join(__dirname, 'proto', f));

// Messages we don't need to log on every tick
const QUIET_TYPES = new Set(['ProtoOASpotEvent', 'ProtoHeartbeatEvent', 'ProtoOATraderRes', 'ProtoOAReconcileRes']);

class CTraderConnection extends EventEmitter {
    constructor(config, tokenManager = null) {
        super();
        this.config       = config;
        this.tokenManager = tokenManager;

        this.socket           = null;
        this.proto            = null;
        this.connected        = false;
        this.authenticated    = false;
        this.isConnecting     = false;

        this.reconnectAttempts = 0;
        this.reconnectDelay    = 1_000;
        this.reconnectTimer    = null;

        this.heartbeatTimer    = null;
        this.lastHeartbeat     = Date.now();

        this.pendingRequests   = new Map();
        this.nextMsgId         = 1;
        this.rxBuffer          = Buffer.alloc(0);
    }

    // ── Proto ─────────────────────────────────────────────────────────────────

    async loadProto() {
        this.proto = await protobuf.load(PROTO_FILES);
        console.log('✅ Protobuf 定義檔載入成功');
    }

    // ── Connect ───────────────────────────────────────────────────────────────

    async connect() {
        if (this.isConnecting) { console.log('⏳ 連線請求進行中，略過重複請求'); return; }
        if (!this.proto) await this.loadProto();
        this.disconnect();
        this.isConnecting = true;

        const { host, port, mode } = this.config.ctrader;
        console.log(`📡 連接 cTrader ${mode} 伺服器 ${host}:${port}...`);

        return new Promise((resolve, reject) => {
            const done = (err) => { this.isConnecting = false; err ? reject(err) : resolve(); };

            this.socket = tls.connect({ host, port, rejectUnauthorized: true }, async () => {
                console.log('✅ TLS 連線建立');
                this.connected         = true;
                this.reconnectAttempts = 0;
                try {
                    await this.sendApplicationAuth();
                    this._startHeartbeat();
                    done();
                } catch (e) { done(e); }
            });

            this.socket.on('data',  data  => { try { this._onData(data); } catch (e) { console.error('❌ 處理訊息失敗:', e); } });
            this.socket.on('close', ()    => { console.log('⚠️  TCP 連線關閉'); this._onClose(); });
            this.socket.on('error', err   => { console.error('❌ Socket 錯誤:', err.message); this.isConnecting = false; reject(err); });

            setTimeout(() => { if (!this.connected) done(new Error('連線逾時')); }, CONNECT_TIMEOUT_MS);
        });
    }

    _onClose() {
        this.connected     = false;
        this.authenticated = false;
        this.isConnecting  = false;
        this._stopHeartbeat();
        this._scheduleReconnect();
    }

    // ── Auth ──────────────────────────────────────────────────────────────────

    async sendApplicationAuth() {
        const msg = this.proto.lookupType('ProtoOAApplicationAuthReq').create({
            clientId:     this.config.ctrader.clientId,
            clientSecret: this.config.ctrader.clientSecret,
        });
        return this.send('ProtoOAApplicationAuthReq', msg);
    }

    async sendAccountAuth() {
        const token = this.tokenManager
            ? this.tokenManager.getAccessToken()
            : this.config.ctrader.accessToken;

        const msg = this.proto.lookupType('ProtoOAAccountAuthReq').create({
            ctidTraderAccountId: parseInt(this.config.ctrader.accountId),
            accessToken: token,
        });
        return this.send('ProtoOAAccountAuthReq', msg);
    }

    // ── Send / Receive ────────────────────────────────────────────────────────

    async send(typeName, payload) {
        if (!this.socket || !this.connected) throw new Error('Socket 未連線');

        const msgId    = (this.nextMsgId++).toString();
        const ProtoMsg = this.proto.lookupType('ProtoMessage');
        const wrapped  = ProtoMsg.create({
            payloadType: this._typeNameToId(typeName),
            payload:     this.proto.lookupType(typeName).encode(payload).finish(),
            clientMsgId: msgId,
        });

        const encoded = ProtoMsg.encode(wrapped).finish();
        const prefix  = Buffer.allocUnsafe(4);
        prefix.writeUInt32BE(encoded.length, 0);
        const packet = Buffer.concat([prefix, encoded]);

        return new Promise((resolve, reject) => {
            this.pendingRequests.set(msgId, { resolve, reject, type: typeName });
            this.socket.write(packet, err => {
                if (err) { this.pendingRequests.delete(msgId); reject(err); }
            });
            setTimeout(() => {
                if (this.pendingRequests.has(msgId)) {
                    this.pendingRequests.delete(msgId);
                    reject(new Error(`Request timeout: ${typeName}`));
                }
            }, REQUEST_TIMEOUT_MS);
        });
    }

    _onData(chunk) {
        this.rxBuffer = Buffer.concat([this.rxBuffer, chunk]);
        let offset = 0;

        while (true) {
            if (this.rxBuffer.length - offset < 4) break;
            const len = this.rxBuffer.readUInt32BE(offset);
            if (len > MAX_PACKET_BYTES || len < 0) {
                console.error(`❌ 異常封包長度 ${len}，清除緩衝區`);
                this.rxBuffer = Buffer.alloc(0);
                return;
            }
            if (this.rxBuffer.length - offset < 4 + len) break;

            const bytes = this.rxBuffer.subarray(offset + 4, offset + 4 + len);
            offset += 4 + len;
            try {
                const msg = this.proto.lookupType('ProtoMessage').decode(bytes);
                this._onMessage(msg);
            } catch (e) { console.error('❌ Protobuf 解碼失敗:', e); }
        }

        if (offset > 0) this.rxBuffer = this.rxBuffer.subarray(offset);
    }

    _onMessage(msg) {
        this.lastHeartbeat = Date.now();
        const typeName = this._typeIdToName(msg.payloadType);

        if (!QUIET_TYPES.has(typeName)) console.log(`📨 收到訊息: ${typeName}`);

        // Resolve pending request
        if (msg.clientMsgId && this.pendingRequests.has(msg.clientMsgId)) {
            const { resolve } = this.pendingRequests.get(msg.clientMsgId);
            this.pendingRequests.delete(msg.clientMsgId);
            resolve(msg);
        }

        // Special handling
        switch (typeName) {
            case 'ProtoOAApplicationAuthRes':
                console.log('✅ Application Auth 成功');
                this.emit('app-auth-success');
                break;

            case 'ProtoOAAccountAuthRes':
                console.log('✅ Account Auth 成功');
                this.authenticated = true;
                this.emit('account-auth-success');
                break;

            case 'ProtoOAErrorRes': {
                const err = this.proto.lookupType('ProtoOAErrorRes').decode(msg.payload);
                console.error(`❌ API 錯誤: ${err.errorCode} – ${err.description || '無描述'}`);
                this.emit('api-error', err);
                if (err.description?.includes('not authorized')) {
                    this.authenticated = false;
                    this.disconnect();
                    this._scheduleReconnect();
                }
                break;
            }

            case 'ProtoOAOrderErrorEvent': {
                const oe = this.proto.lookupType('ProtoOAOrderErrorEvent').decode(msg.payload);
                console.error(`❌ 訂單錯誤: ${oe.errorCode} – ${oe.description || '無描述'}`);
                this.emit('order-error', oe);
                break;
            }

            case 'ProtoHeartbeatEvent':
                // timestamp already updated above
                break;
        }

        this.emit('message', { type: typeName, payload: msg.payload });
    }

    // ── Heartbeat ─────────────────────────────────────────────────────────────

    _startHeartbeat() {
        this._stopHeartbeat();
        this.heartbeatTimer = setInterval(() => {
            if (!this.connected) { this._stopHeartbeat(); return; }
            if (Date.now() - this.lastHeartbeat > HEARTBEAT_TIMEOUT) {
                console.error('❌ Heartbeat 超時，斷開連線');
                this.disconnect();
                return;
            }
            try {
                const hb = this.proto.lookupType('ProtoHeartbeatEvent').create({ payloadType: 51 });
                this.send('ProtoHeartbeatEvent', hb).catch(() => {});
            } catch { /* ignore */ }
        }, HEARTBEAT_INTERVAL);
    }

    _stopHeartbeat() {
        if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    }

    // ── Reconnect ─────────────────────────────────────────────────────────────

    _scheduleReconnect() {
        const delay = Math.min(this.reconnectDelay * 2 ** this.reconnectAttempts, MAX_RECONNECT_DELAY);
        this.reconnectAttempts++;
        console.log(`🔄 ${delay}ms 後重連 (第 ${this.reconnectAttempts} 次)...`);
        this.reconnectTimer = setTimeout(() => {
            this.connect().catch(e => console.error('重連失敗:', e.message));
        }, delay);
    }

    // ── Public ────────────────────────────────────────────────────────────────

    disconnect() {
        this.connected     = false;
        this.authenticated = false;
        this.isConnecting  = false;
        this._stopHeartbeat();
        if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
        if (this.socket) { this.socket.destroy(); this.socket = null; }
        console.log('👋 已斷開 cTrader 連線');
    }

    isHealthy() {
        return this.connected && !!this.socket && (Date.now() - this.lastHeartbeat < HEARTBEAT_TIMEOUT);
    }

    // ── Enum helpers ──────────────────────────────────────────────────────────

    _typeNameToId(name) {
        if (name.startsWith('ProtoOA')) {
            const base  = name.slice(7);
            const snake = base.replace(/([a-z])([A-Z])/g, '$1_$2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2').toUpperCase();
            const key   = `PROTO_OA_${snake}`;
            const e     = this.proto.lookupEnum('ProtoOAPayloadType');
            if (e.values[key] !== undefined) return e.values[key];
            // Fallback: simpler conversion
            const alt = `PROTO_OA_${base.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase()}`;
            return e.values[alt] ?? 0;
        } else {
            const base  = name.slice(5); // remove 'Proto'
            const snake = base.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase();
            return this.proto.lookupEnum('ProtoPayloadType').values[snake] ?? 0;
        }
    }

    _typeIdToName(id) {
        const oaEnum = this.proto.lookupEnum('ProtoOAPayloadType');
        const cmEnum = this.proto.lookupEnum('ProtoPayloadType');

        if (id >= 2000) {
            for (const [name, val] of Object.entries(oaEnum.values)) {
                if (val !== id) continue;
                return name.split('_').map((p, i) => {
                    if (p === 'PROTO') return 'Proto';
                    if (p === 'OA')    return 'OA';
                    return p.charAt(0) + p.slice(1).toLowerCase();
                }).join('');
            }
        } else {
            for (const [name, val] of Object.entries(cmEnum.values)) {
                if (val !== id) continue;
                return 'Proto' + name.split('_').map(p => p.charAt(0) + p.slice(1).toLowerCase()).join('');
            }
        }
        return `Unknown(${id})`;
    }
}

module.exports = CTraderConnection;
