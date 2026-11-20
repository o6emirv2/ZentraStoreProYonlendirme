'use strict';
const express = require('express');
const { requireAuth, strictLimiter } = require('./server-core-security.js');
const router = express.Router();
for (const path of ['/email/request-code', '/email/update-with-code', '/email/update-with-password']) {
  router.post(path, strictLimiter, requireAuth, (_req,res) => res.status(501).json({ ok:false, error:'USE_FIREBASE_EMAIL_REAUTH' }));
}
module.exports = router;
