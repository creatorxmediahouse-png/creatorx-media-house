@echo off
rem Installs the After Effects MCP panel for this Windows user. Double-click to run.
cd /d "%~dp0"
set "DEST=%APPDATA%\Adobe\CEP\extensions\com.creatorx.aemcp"
if exist "%DEST%" rmdir /s /q "%DEST%"
xcopy "com.creatorx.aemcp" "%DEST%\" /e /i /q /y >nul
rem The panel is not a signed .zxp, so let After Effects load unsigned panels.
for %%v in (9 10 11 12 13) do reg add "HKCU\Software\Adobe\CSXS.%%v" /v PlayerDebugMode /t REG_SZ /d 1 /f >nul
echo.
echo Installed. Restart After Effects, then open Window ^> Extensions ^> After Effects MCP.
echo.
pause
