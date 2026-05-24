# 🤖 MR ROBOT Proxy

  Secure proxy server for the MR ROBOT Android app.
  Hides the real backend URL — requests only forwarded when correct `X-App-Secret` header is present.

  ## How it works

  ```
  Android App
      ↓  X-App-Secret: <secret>  +  request
  Proxy Server  (this repo)
      ↓  secret validated ✅ → forward
  Real Backend  (PROXY_TARGET)
      ↓
  Response back to Android
  ```

  ## Environment Variables

  ```env
  PORT=3000
  APP_SECRET=your_strong_secret_here
  PROXY_TARGET=https://mr-robot-5s3.pages.dev/api
  ```

  ## Run

  ```bash
  npm install
  npm run build
  npm start
  ```

  ## Android

  ```kotlin
  const val API_BASE_URL = "https://YOUR_PROXY_URL"
  private const val APP_SECRET = "your_strong_secret_here"
  // .addHeader("X-App-Secret", APP_SECRET)  ← every request
  ```

  ## Deploy

  Works on **Railway**, **Render**, **Heroku**, **Fly.io** — set `APP_SECRET` and `PROXY_TARGET` env vars.
  