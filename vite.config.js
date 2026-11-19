import {fileURLToPath} from 'node:url';
import {defineConfig} from 'vite';

const project = fileURLToPath(new URL('.', import.meta.url));
const routeFiles = ['cities.json', 'landings.json', 'coastline_mask.png', 'seas.json']
  .map(name => fileURLToPath(new URL('../DB/' + name, import.meta.url)));

export default defineConfig({
  server: {fs: {allow: [project, ...routeFiles]}},
});
