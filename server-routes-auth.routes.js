const express = require('express'); const env = require('./server-config-env.js'); const { requireAuth } = require('./server-core-security.js');
const router = express.Router();
router.get('/public/runtime-config', (req,res)=>res.json({ ok:true, apiBase: env.publicApiBase, canonicalOrigin: env.canonicalOrigin, firebase: env.firebase.publicConfig }));
router.get('/auth/me', requireAuth, (req,res)=>res.json({ ok:true, user:req.user }));
module.exports = router;
