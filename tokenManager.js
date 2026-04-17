'use strict';

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const TOKEN_FILE            = path.join(__dirname, '.token_info.json');
const TOKEN_ENDPOINT        = 'https://openapi.ctrader.com/apps/token';
const REFRESH_BUFFER_MS     = 24 * 60 * 60 * 1000; // refresh 1 day before expiry
const CHECK_INTERVAL_MS     =      60 * 60 * 1000; // check every hour

class TokenManager {
    constructor(config) {
        this.clientId     = config.ctrader.clientId;
        this.clientSecret = config.ctrader.clientSecret;
        this.accessToken  = config.ctrader.accessToken;
        this.refreshToken = config.ctrader.refreshToken;
        this.expiresAt    = null;
        this._timer       = null;

        this._loadFromDisk();
    }

    // ── Persistence ──────────────────────────────────────────────────────────

    _loadFromDisk() {
        try {
            if (!fs.existsSync(TOKEN_FILE)) return;
            const data = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
            if (data.accessToken)  this.accessToken  = data.accessToken;
            if (data.refreshToken) this.refreshToken = data.refreshToken;
            if (data.expiresAt)    this.expiresAt    = new Date(data.expiresAt);
            console.log('📄 已載入儲存的 Token 資訊');
        } catch { /* ignore */ }
    }

    _saveToDisk() {
        try {
            fs.writeFileSync(TOKEN_FILE, JSON.stringify({
                accessToken:  this.accessToken,
                refreshToken: this.refreshToken,
                expiresAt:    this.expiresAt?.toISOString(),
                updatedAt:    new Date().toISOString(),
            }, null, 2));
        } catch (e) {
            console.error('Token 儲存失敗:', e.message);
        }
    }

    // ── Refresh ──────────────────────────────────────────────────────────────

    refreshAccessToken() {
        return new Promise((resolve, reject) => {
            const params = new URLSearchParams({
                grant_type:    'refresh_token',
                client_id:     this.clientId,
                client_secret: this.clientSecret,
                refresh_token: this.refreshToken,
            }).toString();

            const url = new URL(TOKEN_ENDPOINT);
            const req = https.request({
                hostname: url.hostname,
                path:     url.pathname,
                method:   'POST',
                headers:  { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(params) },
            }, res => {
                let raw = '';
                res.on('data', c => raw += c);
                res.on('end', () => {
                    try {
                        const body = JSON.parse(raw);
                        if (!body.access_token) return reject(new Error(body.error_description || body.error || 'Token 刷新失敗'));

                        this.accessToken  = body.access_token;
                        if (body.refresh_token) this.refreshToken = body.refresh_token;

                        const expiresIn = body.expires_in || 2_628_000; // ~30 days
                        this.expiresAt  = new Date(Date.now() + expiresIn * 1000);
                        this._saveToDisk();
                        console.log('✅ Access Token 已更新，有效期至:', this.expiresAt.toLocaleString());
                        resolve(this.accessToken);
                    } catch (e) {
                        reject(new Error('Token 回應解析失敗: ' + e.message));
                    }
                });
            });

            req.on('error', reject);
            req.write(params);
            req.end();
        });
    }

    async checkAndRefresh() {
        if (!this.expiresAt) {
            console.log('⏰ Token 過期時間未知，嘗試更新...');
            return this.refreshAccessToken();
        }
        const remaining = this.expiresAt.getTime() - Date.now();
        if (remaining < REFRESH_BUFFER_MS) {
            console.log('⏰ Token 即將過期，更新中...');
            return this.refreshAccessToken();
        }
        console.log(`🔑 Token 有效，剩餘 ${Math.floor(remaining / 86_400_000)} 天`);
        return this.accessToken;
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    startAutoRefresh() {
        if (this._timer) return;
        this.checkAndRefresh().catch(e => console.error('Token 首次檢查失敗:', e.message));
        this._timer = setInterval(() => {
            this.checkAndRefresh().catch(e => console.error('Token 自動更新失敗:', e.message));
        }, CHECK_INTERVAL_MS);
        console.log('🔄 Token 自動更新已啟動');
    }

    stopAutoRefresh() {
        if (this._timer) { clearInterval(this._timer); this._timer = null; }
    }

    getAccessToken() { return this.accessToken; }
}

module.exports = TokenManager;
