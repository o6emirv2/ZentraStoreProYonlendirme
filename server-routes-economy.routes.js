'use strict';
const express = require('express');
const { requireAuth } = require('./server-core-security.js');
const router = express.Router();
router.post('/economy/reward', requireAuth, (_req,res) => res.status(410).json({ ok:false, error:'UNAUTHORIZED_REWARD_FLOW_REMOVED' }));
module.exports = router;
