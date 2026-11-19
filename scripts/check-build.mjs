import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { buildClient } from './build-lib.mjs'
const root = fileURLToPath(new URL('../', import.meta.url))
const [{ output }, current] = await Promise.all([buildClient({ root, write: false }), readFile(`${root}client.js`, 'utf8')])
if (current !== output) throw new Error('client.js is stale; run npm run build')
console.log('dsh-hr-interview browser bundle is up to date')
