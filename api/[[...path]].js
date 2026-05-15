import { app, initializeDatabase } from '../server/app.js'

await initializeDatabase()

export default function handler(request, response) {
  return app(request, response)
}
