import {mkdir,copyFile,readdir} from 'node:fs/promises';
await mkdir('public/ocr',{recursive:true});
await copyFile('node_modules/tesseract.js/dist/worker.min.js','public/ocr/worker.min.js');
for(const name of await readdir('node_modules/tesseract.js-core')) if (/\.wasm(\.js)?$/.test(name)) await copyFile(`node_modules/tesseract.js-core/${name}`,`public/ocr/${name}`);
await copyFile('node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz','public/ocr/eng.traineddata.gz');
