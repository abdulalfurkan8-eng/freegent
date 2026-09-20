import chalk from 'chalk';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
function version(): string { try { const here=fileURLToPath(import.meta.url); const pkg=JSON.parse(readFileSync(join(here,'../../../package.json'),'utf8')) as {version?:string}; return pkg.version ?? 'unknown'; } catch { return 'unknown'; } }
export const VERSION = version();
export function printBanner(cwd:string):void{const rows=[`* FreeGent v${VERSION}`,'Free AI coding agent - creative, autonomous, and verified'];const w=Math.max(...rows.map(r=>r.length))+4;const border=(l:string,r:string)=>chalk.cyan(l+'─'.repeat(w)+r);console.log(border('╭','╮'));rows.forEach((row,i)=>{const padded=`  ${row}${' '.repeat(w-row.length-2)}`;console.log(chalk.cyan('│')+(i===0?chalk.bold.white(padded):chalk.dim(padded))+chalk.cyan('│'));});console.log(border('╰','╯'));console.log(chalk.dim(`  dir   ${cwd}`));console.log(chalk.dim('  keys  Enter send · Ctrl+C cancel task · Ctrl+C twice exit · Alt+V paste image'));console.log(chalk.dim('  cmds  /help /resume /fork /rewind /image /clear /exit'));console.log('');}
