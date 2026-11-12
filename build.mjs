import {readFile,writeFile} from 'node:fs/promises';

const read=path=>readFile(new URL(path,import.meta.url),'utf8');
const [html,css,engine,app]=await Promise.all([read('dist/index.html'),read('dist/style.css'),read('dist/engine.js'),read('dist/app.js')]);
// The standalone artifact has no network or module-loading dependencies.
const styles=css.replace(/^@import\s+url\([^)]*\);\s*/,'');
const script=engine.replace(/^export /gm,'')+'\n'+app.replace(/^import [^\n]+\n/,'');
const standalone=html
  .replace(/<link rel="stylesheet" href="\.\/style\.css(?:\?[^"\s]*)?">/,()=>`<style>\n${styles}\n</style>`)
  .replace(/<script type="module" src="\.\/app\.js(?:\?[^"\s]*)?"><\/script>/,()=>`<script>\n'use strict';\n${script.replaceAll('</script','<\\/script')}\n</script>`);
await writeFile(new URL('chargewise.html',import.meta.url),standalone);
console.log('已生成 chargewise.html，可直接用浏览器打开。');
