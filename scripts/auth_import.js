#!/usr/bin/env node
'use strict';
const fs=require('fs'),path=require('path'); const input=process.argv[2],out=process.env.DEEPSEEK_AUTH_PATH||path.join(__dirname,'..','deepseek-auth.json');
if(!input){console.error('Usage: npm run auth:import -- path\\to\\deepseek-auth.json');process.exit(2);} try{const a=JSON.parse(fs.readFileSync(input,'utf8'));if(!a.token||!a.cookie)throw new Error('token/cookie missing');fs.writeFileSync(out,JSON.stringify(a,null,2),{mode:0o600});console.log('Auth imported without printing secrets.');}catch(e){console.error(`Import failed: ${e.message}`);process.exit(1);}
