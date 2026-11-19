'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = __dirname;
const dest = path.join(root, 'dist');
const exact = new Set(['index.html','style.css','script.js','favicon.ico','apple-touch-icon.png','site.webmanifest']);
const prefixes = ['games-','public-'];
const allowedExt = new Set(['.html','.css','.js','.mjs','.json','.svg','.png','.jpg','.jpeg','.webp','.ico']);
fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });
const copied=[];
for(const entry of fs.readdirSync(root,{withFileTypes:true})) {
  if(!entry.isFile()) continue;
  const name=entry.name;
  if(!exact.has(name) && !(prefixes.some(prefix => name.startsWith(prefix)) && allowedExt.has(path.extname(name).toLowerCase()))) continue;
  fs.copyFileSync(path.join(root,name),path.join(dest,name));
  copied.push(name);
}
const adminSource=path.join(root,'admin');
const adminDest=path.join(dest,'admin');
if(!fs.statSync(adminSource).isDirectory()) throw new Error('Missing admin directory');
fs.cpSync(adminSource,adminDest,{recursive:true});
if(!fs.existsSync(path.join(dest,'index.html')) || !fs.existsSync(path.join(dest,'games-chess-index.html'))) throw new Error('Incomplete hosting build');
for(const name of fs.readdirSync(dest)) if(/^server(?:-|\.js$)|^scripts-|^tests-|^package\.json$/.test(name)) throw new Error('Private backend source in hosting output: '+name);
console.log(`HOSTING_BUILD_PASS public files=${copied.length} admin=present backend=excluded`);
