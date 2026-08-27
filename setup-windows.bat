@echo off
setlocal
cd /d "%~dp0"

echo ================================================
echo FlyRank Metering ^& Billing - Windows Setup
echo ================================================

echo.
node --version >nul 2>&1
if errorlevel 1 (
  echo ERROR: Node.js is not installed or not in PATH.
  pause
  exit /b 1
)

docker --version >nul 2>&1
if errorlevel 1 (
  echo ERROR: Docker is not installed or not in PATH.
  pause
  exit /b 1
)

echo [1/4] Installing Node dependencies...
npm install
if errorlevel 1 goto :fail

echo [2/4] Starting PostgreSQL...
docker compose up -d
if errorlevel 1 goto :fail

echo [3/4] Creating local environment file...
if not exist .env copy /Y .env.example .env >nul

echo [4/4] Seeding demo tenant...
node scripts\seed.js
if errorlevel 1 goto :fail

echo.
echo ================================================
echo Local setup is complete.
echo ================================================
echo.
echo Next:
echo 1. Put your Stripe TEST key and Price ID in .env
echo 2. Start the app with: npm start
echo 3. In another terminal run: stripe listen --forward-to localhost:3000/webhooks/stripe
echo 4. Put the returned whsec_ value in .env as STRIPE_WEBHOOK_SECRET
echo.
echo Do NOT commit .env or share secret keys.
pause
exit /b 0

:fail
echo.
echo Setup failed. Read the error above.
pause
exit /b 1
