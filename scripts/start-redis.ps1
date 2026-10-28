# Keep this terminal open while using Drift: WSL may stop when no Linux shell remains.
wsl.exe -d Ubuntu -u root --exec sh -c 'service redis-server start && redis-cli ping && exec sleep infinity'
exit $LASTEXITCODE
