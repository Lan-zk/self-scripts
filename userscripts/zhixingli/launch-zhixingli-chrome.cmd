@echo off
rem ============================================================
rem  Zhixingli dedicated Chrome launcher
rem
rem  Runs an ISOLATED Chrome instance tuned for unattended
rem  autoplay: no timer throttling, no occlusion->hidden,
rem  no renderer backgrounding. Your main Chrome (its profile,
rem  extensions, settings) is completely untouched.
rem
rem  First launch opens an empty profile: install Tampermonkey,
rem  the userscript, and log in to u.exexm.com once.
rem  See README.md -> "推荐运行方式：专用浏览器实例" for setup.
rem ============================================================
setlocal EnableExtensions

rem -- Locate chrome.exe (edit this line if yours lives elsewhere)
set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=%LocalAppData%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" (
  echo [ERROR] chrome.exe not found. Edit the CHROME line in this file.
  pause
  exit /b 1
)

rem -- Isolated profile directory (independent from main Chrome)
set "PROFILE=%LocalAppData%\zhixingli-chrome"

start "" "%CHROME%" --user-data-dir="%PROFILE%" --no-first-run --no-default-browser-check --disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-media-suspend --autoplay-policy=no-user-gesture-required --disable-features=IntensiveWakeUpThrottling,CalculateNativeWinOcclusion "https://u.exexm.com/"

endlocal
