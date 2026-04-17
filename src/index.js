require("dotenv").config();

try {
  const bot = require("./bot/TradingBotApp");
  module.exports = bot;
} catch (error) {
  console.error("Fatal application bootstrap error:", error);
  process.exit(1);
}
