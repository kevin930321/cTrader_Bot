'use strict';

const { MongoClient } = require('mongodb');

const DB_NAME          = 'trading-bot';
const COL_PROFILES     = 'profiles';
const COL_STATE        = 'bot_state';
const STATE_ID         = 'current_state';

let client = null;
let db     = null;

async function connect() {
    if (client) return;
    const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/us30-bot';
    client = new MongoClient(uri);
    await client.connect();
    db = client.db(DB_NAME);
    console.log('✅ MongoDB 連線成功');
}

function col(name) {
    if (!db) throw new Error('MongoDB 尚未連線');
    return db.collection(name);
}

// ── Profiles ────────────────────────────────────────────────────────────────

async function loadProfiles() {
    try {
        await connect();
        const list = await col(COL_PROFILES).find({}).toArray();
        console.log(`📂 載入 ${list.length} 個 Profile`);
        return list;
    } catch (e) {
        console.error('❌ 載入 Profiles 失敗:', e.message);
        return [];
    }
}

async function saveProfile(profile) {
    await connect();
    return col(COL_PROFILES).updateOne({ id: profile.id }, { $set: profile }, { upsert: true });
}

async function saveAllProfiles(profiles) {
    if (!profiles.length) return;
    await connect();
    const ops = profiles.map(p => ({
        updateOne: { filter: { id: p.id }, update: { $set: p }, upsert: true },
    }));
    await col(COL_PROFILES).bulkWrite(ops);
}

async function deleteProfile(id) {
    try {
        await connect();
        const r = await col(COL_PROFILES).deleteOne({ id });
        return r.deletedCount > 0;
    } catch (e) {
        console.error('❌ 刪除 Profile 失敗:', e.message);
        return false;
    }
}

// ── Bot State ────────────────────────────────────────────────────────────────

async function loadState() {
    try {
        await connect();
        return await col(COL_STATE).findOne({ _id: STATE_ID });
    } catch (e) {
        console.error('❌ 載入狀態失敗:', e.message);
        return null;
    }
}

async function saveState(state) {
    try {
        await connect();
        await col(COL_STATE).updateOne(
            { _id: STATE_ID },
            { $set: { ...state, _id: STATE_ID } },
            { upsert: true },
        );
    } catch (e) {
        console.error('❌ 儲存狀態失敗:', e.message);
    }
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

async function closeDB() {
    if (client) {
        await client.close();
        client = null;
        db     = null;
        console.log('🔌 MongoDB 連線已關閉');
    }
}

module.exports = { loadProfiles, saveProfile, saveAllProfiles, deleteProfile, loadState, saveState, closeDB };
