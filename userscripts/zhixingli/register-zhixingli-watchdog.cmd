@echo off
rem ============================================================
rem  Register the zhixingli out-of-page watchdog as a
rem  scheduled task (runs every 5 minutes while logged on).
rem
rem  Remove with:
rem    schtasks /Delete /TN "zhixingli-watchdog" /F
rem ============================================================
schtasks /Create /TN "zhixingli-watchdog" /TR "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"%~dp0watchdog-zhixingli.ps1\"" /SC MINUTE /MO 5 /F
if errorlevel 1 (
  echo [ERROR] task creation failed.
) else (
  echo [OK] watchdog registered: runs every 5 minutes while logged on.
  echo       Log: %%LocalAppData%%\zhixingli-chrome\watchdog.log
)
pause
