/**
 * MongoDB 資料庫連線與機器人狀態操作
 */

const { MongoClient } = require('mongodb');


// 連線字串從環境變數讀取
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/nas100-bot';
const DB_NAME = 'trading-bot';
const STATE_COLLECTION = 'bot_state';

let client = null;
let db = null;

/**
 * 連線到 MongoDB
 */
async function connectDB() {
    // MongoDB 5.x: 使用 client 存在性檢查，driver 內部自動管理連線池
    if (client && db) {
        return db;
    }

    try {
        client = new MongoClient(MONGODB_URI);
        await client.connect();
        db = client.db(DB_NAME);
        console.log('✅ MongoDB 連線成功');
        return db;
    } catch (error) {
        console.error('❌ MongoDB 連線失敗:', error.message);
        throw error;
    }
}

/**
 * 關閉連線
 */
async function closeDB() {
    if (client) {
        await client.close();
        client = null;
        db = null;
        console.log('🔌 MongoDB 連線已關閉');
    }
}

/**
 * 載入機器人狀態
 */
async function loadState() {
    try {
        await connectDB();
        const stateCol = db.collection(STATE_COLLECTION);
        const state = await stateCol.findOne({ _id: 'current_state' });

        if (state) {
            console.log('📂 從 MongoDB 載入機器人狀態');
            return state;
        }
        return null;
    } catch (error) {
        console.error('❌ 載入狀態失敗:', error.message);
        return null;
    }
}

/**
 * 儲存機器人狀態
 */
async function saveState(stateData) {
    try {
        await connectDB();
        const stateCol = db.collection(STATE_COLLECTION);
        await stateCol.updateOne(
            { _id: 'current_state' },
            { $set: { ...stateData, _id: 'current_state' } },
            { upsert: true }
        );
    } catch (error) {
        console.error('❌ 儲存狀態失敗:', error.message);
    }
}

module.exports = {
    connectDB,
    loadState,
    saveState,
    closeDB
};
