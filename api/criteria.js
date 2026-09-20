// GET /api/criteria —— 把判别标准暴露出来，前端不用复制一份（避免两边不一致）

const jev = require("../lib/jev");

module.exports = function handler(req, res) {
  res.setHeader("cache-control", "public, max-age=300");
  res.status(200).json({
    action: jev.ACTION_CRITERIA,
    risk: jev.RISK_CRITERIA,
    model: jev.MODEL,
  });
};
