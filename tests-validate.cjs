'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = __dirname;
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const exists = name => fs.existsSync(path.join(root, name));
const sourceFiles = fs.readdirSync(root, {withFileTypes:true})
  .filter(entry => entry.isFile()).map(entry => entry.name);
const adminFiles = fs.readdirSync(path.join(root,'admin'),{withFileTypes:true});
for(const name of ['index.html','admin','server.js','games-chess-index.html','games-crash-index.html','games-pisti-index.html','games-snake-pro-index.html','games-space-pro-index.html','games-pattern-master-index.html','server-config-env.js','server-core-rewardPolicy.js','package.json','firebase.json','scripts-build-hosting.cjs']) assert(exists(name),`Missing: ${name}`);
for(const name of ['games','public','server','scripts','tests']) assert(!exists(name),`Unexpected nested directory: ${name}`);
for(const entry of adminFiles) assert(entry.isFile(),`Nested admin file: ${entry.name}`);
for(const entry of fs.readdirSync(root,{withFileTypes:true})) assert(entry.isFile() || entry.name==='admin' || entry.name==='dist',`Unexpected folder: ${entry.name}`);
const pkg = JSON.parse(read('package.json'));
const hosting = JSON.parse(read('firebase.json'));
assert.equal(pkg.scripts['build:hosting'],'node scripts-build-hosting.cjs');
assert.equal(pkg.scripts['check:syntax'],'node tests-validate.cjs');
assert.equal(hosting.hosting.public,'dist');
assert(pkg.dependencies.firebase && pkg.dependencies['firebase-admin']);
const policy = read('server-core-rewardPolicy.js');
assert.match(policy,/SIGNUP_MC\s*=\s*1000\s*;/);
assert.match(policy,/EMAIL_VERIFICATION_MC\s*=\s*2000\s*;/);
const firebase=read('public-firebase-public-contract.js');
for(const expected of ['playmatrix-13da1','1:249202046436:web:c700f8dc64318cd92a83f1','AIzaSyBtwFnAEmTMzNT7ekrAAkfH0SG3VfajW4Y']) assert(firebase.includes(expected));
assert(!firebase.includes('1:249202046436:web:37f609d8527e61a72c5f03'));
const page=read('index.html');
for(const id of ['pmHeroTitle','pmHeroDescription','pmGamesTitle','pmGamesSubtitle','pmSiteAnnouncement']) assert(page.includes(`id="${id}"`),`${id} missing`);
assert(page.includes('1.000 MC') && page.includes('2.000 MC'));
for (const asset of ['public-assets-images-promo-signup.webp','public-assets-images-promo-verify.webp','public-assets-images-promo-signup.jpg','public-assets-images-promo-verify.jpg']) assert(exists(asset),`Missing supplied banner: ${asset}`);
for (const mobileAsset of ['public-assets-images-promo-signup-mobile.webp','public-assets-images-promo-verify-mobile.webp']) assert(exists(mobileAsset),`Missing mobile crop: ${mobileAsset}`);
assert.match(page,/data-pm-slide-action="register"/);
assert.match(page,/data-pm-slide-action="verify"/);
assert.match(read('style.css'),/grid-template-columns:repeat\(4,minmax\(0,1fr\)\)!important/);
assert.match(read('style.css'),/grid-template-columns:repeat\(2,minmax\(0,1fr\)\)!important/);
assert.match(read('server-core-economyService.js'),/PROFILE_NOT_READY/);
assert.match(read('server.js'),/protectAsyncRoutes\(crashGame\.router\)/);
assert.match(read('server.js'),/dataReadiness\.verifyDataReady/);
assert.match(read('server.js'),/FIRESTORE_CLEANUP_ENABLED !== '1'/);
assert(!read('server-routes-compat.routes.js').includes('profile.balance = memoryBalance'));
assert(!read('public-js-home-legacy-home.runtime.js').includes('function buildHeroPromoSlides'));
assert.match(read('server.js'),/allowedPublicAsset/);
assert.match(read('server.js'),/games-\$\{safeSlug\}-index\.html/);
assert.match(read('server-routes-economy.routes.js'),/UNAUTHORIZED_REWARD_FLOW_REMOVED/);
assert.match(read('server-routes-content.routes.js'),/router\.put\('\/admin\/site\/content'/);
assert(!sourceFiles.some(name=>name.includes('frame-picker')||name.includes('avatar-frame')));
assert(!sourceFiles.some(name=>name.startsWith('RENDER_ENV_')),'Private Render env must remain outside public root');
const httpAssets=[]; const jsFiles=sourceFiles.filter(name => /\.(?:js|cjs|mjs)$/.test(name));
const htmlFiles=sourceFiles.filter(name=>name.endsWith('.html')).concat(adminFiles.filter(e=>e.name.endsWith('.html')).map(e=>`admin/${e.name}`));
let refs=0, modules=0, styles=0;
function absoluteUrlIsExternal(url) {return /^(?:https?:|data:|blob:|mailto:|tel:|javascript:|#|\/\/)/i.test(url);}
function assetPath(url, file){
 const base=url.split(/[?#]/)[0];
 if(!base || absoluteUrlIsExternal(url) || url.includes('${') || url.includes('{{')) return null;
 let v;
 try{v=decodeURIComponent(base);}catch{v=base;}
 const resolved = v.startsWith('/') ? path.join(root,v.slice(1)) : path.resolve(root,path.dirname(file),v);
 assert(resolved.startsWith(root+path.sep)|| resolved===root,`File path traversal: ${file} : ${url}`);
 return resolved;
}
for(const file of htmlFiles){
 const contents=read(file);
 assert.match(contents,/<html/i,`Missing html root ${file}`);
 for(const match of contents.matchAll(/\b(?:src|href|poster)\s*=\s*["']([^"']+)["']/g)){
  const asset=assetPath(match[1],file); if(!asset)continue;
  assert(fs.existsSync(asset),`Missing asset: ${file} -> ${match[1]}`);refs++;
 }
}
for(const file of jsFiles.concat(adminFiles.filter(e=>e.name.endsWith('.js')).map(e=>`admin/${e.name}`))){
 const content=fs.readFileSync(path.join(root,file));
 const check=(args)=>spawnSync(process.execPath,args,{input:content,timeout:10000,encoding:'utf8'});
 let r=check(['--check']);
 if(r.status!==0) r=check(['--input-type=module','--check']);
 assert.equal(r.status,0,`JS syntax: ${file} ${String(r.stderr).slice(0,300)}`);
 const src=content.toString('utf8');
 const pattern=/\brequire\s*\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)|\b(?:from\s+|import\s*\(|import\s+)["'](\.{1,2}\/[^"']+|\/public-[^"']+|\/games-[^"']+)["']/g;
 for(const m of src.matchAll(pattern)) {
  const reference=m[1]||m[2];
  const asset=assetPath(reference,file);
  assert(asset && (fs.existsSync(asset)||fs.existsSync(asset+'.js')||fs.existsSync(path.join(asset,'index.js'))),`Broken JS dependency: ${file} -> ${reference}`);
  modules++;
 }
}
for(const name of sourceFiles.filter(name=>name.endsWith('.css'))){
 const contents=read(name);
 for(const match of contents.matchAll(/url\(\s*["']?([^\)"']+)["']?\s*\)/g)) {
  const url=match[1].trim();const asset=assetPath(url,name);
  if(!asset)continue;
  assert(fs.existsSync(asset),`Broken CSS asset: ${name} -> ${url}`);styles++;
 }
}
for(const item of ['games-chess-index.html','games-crash-index.html','games-pisti-index.html','games-snake-pro-index.html','games-space-pro-index.html','games-pattern-master-index.html']) {
 assert(hosting.hosting.rewrites.some(x=>x.destination==='/'+item),`Hosting rewrite missing ${item}`);
}
// Regression guards for discontinued XP payouts and first-five MC promotion.
for (const file of ['server-games-classicEngine.js','server-games-crash-index.js','server-games-chess-index.js']) {
 const code=read(file);
 assert(!/xpAwarded|awardCrashXp|applyXpAndStats|calculateXp|XP_PER_UNIT|BET_XP_PER_1000_MC/.test(code),`Gameplay XP must be disabled: ${file}`);
}
for(const file of ['index.html','public-js-home-legacy-home.runtime.js']) {
 assert(!/İlk 5 Oyuncuya|İlk 5 oyuncu aylık aktiflik ödülü|activityLadder/.test(read(file)),`Discontinued promotion: ${file}`);
}
assert.match(read('server.js'),/allowedPublicAsset/, 'No explicit source-root public allowlist');
assert(!read('server.js').includes('app.use(express.static(__dirname'), 'Server root must not be served wholesale');
const dist=path.join(root,'dist');
if(fs.existsSync(dist)) {
 assert(fs.existsSync(path.join(dist,'index.html')));
 assert(!fs.readdirSync(dist).some(name=>/^server-|^tests-|^scripts-|^RENDER_ENV/.test(name)), 'Private code exposed in Firebase Hosting');
}
console.log(`PASS: source root layout, ${htmlFiles.length} HTML pages, ${refs} file links, ${jsFiles.length} root JS files + admin JS, ${modules} local dependencies, ${styles} CSS URLs, reward policy, Firebase config, Render source protection, Hosting whitelist.`);
