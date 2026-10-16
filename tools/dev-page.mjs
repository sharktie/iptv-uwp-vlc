#!/usr/bin/env node
// Runs JavaScript in the page of a Debug build of the app running on this PC, and prints what it
// returns. Nothing outside a Windows app can connect to it, so this goes through files in the
// app's LocalState folder, which Debug builds watch (StartDevCommands in IPTV/MainPage.xaml.cs).
//
//   node tools/dev-page.mjs "document.title"
//   node tools/dev-page.mjs --file script.js
//   node tools/dev-page.mjs --key down           a controller button, as the app sends it
//   node tools/dev-page.mjs --log [lines]        the end of the app's log
//   node tools/dev-page.mjs "#cdp Emulation.setDeviceMetricsOverride {...}"   a DevTools call
//
// The script runs as with ExecuteScriptAsync: the value of its last expression comes back as
// JSON (a Promise comes back as {}, so store async results on window and read them after).

import { existsSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const IDENTITY = '874fbd47-da0c-46cb-8890-690f84bc89db_';
const packages = join(process.env.LOCALAPPDATA || '', 'Packages');
const family = existsSync(packages) && readdirSync(packages).find((name) => name.startsWith(IDENTITY));
if (!family) {
  console.error('The app is not installed on this PC (deploy a Debug build from Visual Studio first).');
  process.exit(1);
}
const folder = join(packages, family, 'LocalState');
const args = process.argv.slice(2);

if (args[0] === '--log') {
  const lines = Number(args[1]) || 40;
  const text = readFileSync(join(folder, 'iptv-vlc.log'), 'utf8').trimEnd().split('\n');
  console.log(text.slice(-lines).join('\n'));
  process.exit(0);
}

let script;
if (args[0] === '--file') script = readFileSync(args[1], 'utf8');
else if (args[0] === '--key') script = `Native.receive({ type: 'input', action: ${JSON.stringify(args[1])}, repeat: false }); 'sent ${args[1]}'`;
else script = args.join(' ');
if (!script) {
  console.error('Nothing to run.');
  process.exit(1);
}

const command = join(folder, 'dev-command.js');
const result = join(folder, 'dev-result.json');
try { unlinkSync(result); } catch {}
writeFileSync(command + '.tmp', script);
renameSync(command + '.tmp', command);

const deadline = Date.now() + 15000;
const timer = setInterval(() => {
  if (existsSync(result)) {
    clearInterval(timer);
    const text = readFileSync(result, 'utf8');
    unlinkSync(result);
    try { console.log(JSON.stringify(JSON.parse(text), null, 2)); } catch { console.log(text); }
  } else if (Date.now() > deadline) {
    clearInterval(timer);
    try { unlinkSync(command); } catch {}
    console.error('No answer: is a Debug build of the app running?');
    process.exit(1);
  }
}, 100);
