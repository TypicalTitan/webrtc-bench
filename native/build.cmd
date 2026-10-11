@echo off
rem Builds native\build\wbsend.exe with the Visual Studio C++ Build Tools.
setlocal
cd /d "%~dp0"
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
for /f "usebackq tokens=*" %%i in (`call "%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VSPATH=%%i"
if not defined VSPATH (
  echo Visual Studio C++ Build Tools not found.
  exit /b 1
)
call "%VSPATH%\VC\Auxiliary\Build\vcvars64.bat" >nul || exit /b 1
if not exist build mkdir build
cl /nologo /O2 /EHsc /std:c++17 /W3 /MT /DUNICODE /D_UNICODE /DWIN32_LEAN_AND_MEAN /DNOMINMAX ^
   /I third_party\nvenc src\main.cpp src\source.cpp src\nvenc.cpp src\rtp.cpp ^
   /Fobuild\ /Fe:build\wbsend.exe ^
   /link d3d11.lib dxgi.lib mfplat.lib mfreadwrite.lib mfuuid.lib ws2_32.lib ole32.lib winmm.lib propsys.lib
exit /b %ERRORLEVEL%
