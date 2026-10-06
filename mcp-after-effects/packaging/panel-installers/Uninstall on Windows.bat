@echo off
rem Removes the After Effects MCP panel. Double-click to run.
rmdir /s /q "%APPDATA%\Adobe\CEP\extensions\com.creatorx.aemcp"
echo.
echo Removed. Restart After Effects to finish.
echo.
pause
