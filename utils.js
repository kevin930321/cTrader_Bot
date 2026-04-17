'use strict';

const API_PRICE_MULTIPLIER = 100_000;

/** 轉換 Protobuf Long 物件為 JavaScript Number */
function convertLongValue(value) {
    if (value == null) return null;
    if (typeof value === 'object' && typeof value.toNumber === 'function') return value.toNumber();
    return typeof value === 'number' ? value : Number(value);
}

const rawToRealPrice = (raw) => raw / API_PRICE_MULTIPLIER;
const realToRawPrice = (real) => real * API_PRICE_MULTIPLIER;

/** 取得台北時間 Date 物件 */
function getTaipeiTime(date = new Date()) {
    return new Date(date.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
}

/** YYYY-MM-DD 台北時間日期字串 */
function getTaipeiDateString(date = new Date()) {
    return date.toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
}

/**
 * 判斷是否為美股夏令時間
 * DST: 3月第2個週日 ~ 11月第1個週日
 */
function isUsDst(date = new Date()) {
    const y = date.getFullYear();

    const nthSunday = (month, n) => {
        const d = new Date(y, month, 1);
        while (d.getDay() !== 0) d.setDate(d.getDate() + 1);
        d.setDate(d.getDate() + (n - 1) * 7);
        return d;
    };

    const dstStart = nthSunday(2, 2); // March 2nd Sunday
    const dstEnd   = nthSunday(10, 1); // November 1st Sunday
    return date >= dstStart && date < dstEnd;
}

module.exports = {
    API_PRICE_MULTIPLIER,
    convertLongValue,
    rawToRealPrice,
    realToRawPrice,
    getTaipeiTime,
    getTaipeiDateString,
    isUsDst,
};
