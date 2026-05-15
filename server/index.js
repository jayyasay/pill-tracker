import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import express from 'express'

import { app, initializeDatabase } from './app.js'

const port = Number(process.env.PORT ?? 3001)

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const distDir = path.resolve(__dirname, '..', 'dist')

if (fs.existsSync(distDir)) {
  app.use(express.static(distDir))
  app.get(/^(?!\/api\/).*/, (_request, response) => {
    response.sendFile(path.join(distDir, 'index.html'))
  })
}

await initializeDatabase()

app.listen(port, () => {
  console.log(`Pill tracker backend listening on http://localhost:${port}`)
})
