import { fileURLToPath } from 'node:url'
import { buildClient } from './build-lib.mjs'
const root = fileURLToPath(new URL('../', import.meta.url))
const result = await buildClient({ root })
console.log(`Built ${result.packageName} browser client`)
