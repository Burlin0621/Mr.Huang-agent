import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8')

const llm = read('src/lib/llm.ts')
const bridge = read('src/lib/desktop-bridge.ts')
const main = read('electron/main.cjs')
const vite = read('vite.config.ts')

assert.match(llm, /const method: 'GET' \| 'POST' = apiPath === '\/models' \? 'GET' : 'POST'/)
assert.match(llm, /\.\.\.\(method === 'POST' \? \{ body: prepared\.body \} : \{\}\)/)
assert.match(llm, /fetch\(url, \{\s*method: 'POST'/)
assert.match(bridge, /method\?: 'GET' \| 'POST'/)
assert.match(bridge, /body\?: string/)
assert.match(main, /method: payload\.method \|\| 'POST'/)
assert.match(main, /body: payload\.method === 'GET' \? undefined : payload\.body/)
assert.match(vite, /method: req\.method \?\? 'POST'/)
assert.match(vite, /if \(req\.method !== 'GET' && req\.method !== 'HEAD'\)/)

console.log('LLM forward contract checks passed: GET /models, POST chat, and browser proxy method forwarding.')
