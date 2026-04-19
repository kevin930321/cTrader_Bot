/**
 * MongoDB 資料庫連線與 Profile CRUD 操作
 */

const { MongoClient } = require('mongodb');


// 連線字串從環境變數讀取
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/nas100-bot';
const DB_NAME = 'trading-bot';
const COLLECTION_NAME = 'profiles';
const STATE_COLLECTION = 'bot_state'; // 新增：機器人狀態集合

let client = null;
let db = null;
let collection = null;

/**
 * 連線到 MongoDB
 */
async function connectDB() {
    // MongoDB 5.x: 使用 client 存在性檢查，driver 內部自動管理連線池
    if (client && collection) {
        return collection;
    }

    try {
        client = new MongoClient(MONGODB_URI);
        await client.connect();
        db = client.db(DB_NAME);
        collection = db.collection(COLLECTION_NAME);
        console.log('✅ MongoDB 連線成功');
        return collection;
    } catch (error) {
        console.error('❌ MongoDB 連線失敗:', error.message);
        throw error;
    }
}

/**
 * 載入所有 Profiles
 */
async function loadProfiles() {
    try {
        await connectDB();
        const profiles = await collection.find({}).toArray();
        console.log(`📂 從 MongoDB 載入 ${profiles.length} 個 Profile`);
        return profiles;
    } catch (error) {
        console.error('❌ 載入 Profiles 失敗:', error.message);
        return [];
    }
}

/**
 * 儲存/更新單一 Profile
 */
async function saveProfile(profileData) {
    try {
        await connectDB();
        const result = await collection.updateOne(
            { id: profileData.id },
            { $set: profileData },
            { upsert: true }
        );
        return result;
    } catch (error) {
        console.error('❌ 儲存 Profile 失敗:', error.message);
        throw error;
    }
}

/**
 * 儲存所有 Profiles (批量)
 */
async function saveAllProfiles(profilesData) {
    try {
        await connectDB();
        const operations = profilesData.map(p => ({
            updateOne: {
                filter: { id: p.id },
                update: { $set: p },
                upsert: true
            }
        }));

        if (operations.length > 0) {
            await collection.bulkWrite(operations);
        }
    } catch (error) {
        console.error('❌ 批量儲存 Profiles 失敗:', error.message);
    }
}

/**
 * 刪除 Profile
 */
async function deleteProfile(profileId) {
    try {
        await connectDB();
        const result = await collection.deleteOne({ id: profileId });
        return result.deletedCount > 0;
    } catch (error) {
        console.error('❌ 刪除 Profile 失敗:', error.message);
        return false;
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
        collection = null;
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
    loadProfiles,
    saveProfile,
    saveAllProfiles,
    deleteProfile,
    loadState,
    saveState,
    closeDB
};
