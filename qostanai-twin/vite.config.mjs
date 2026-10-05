import { readFileSync } from 'node:fs';
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
export default {
  server: { proxy: { '/api': 'http://127.0.0.1:4173', '/openapi.json': 'http://127.0.0.1:4173' } },
  plugins: [{
    name: 'qostanai-build-info',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'build-info.json', source: JSON.stringify({ version, builtAt: new Date().toISOString() }, null, 2) });
    },
  }],
};
