# usage: run.sh 'js code'  -> waits for result
rm -f /tmp/sd/out.txt; printf '%s' "$1" > /tmp/sd/cmd.js
for i in $(seq 1 ${2:-120}); do [ -f /tmp/sd/out.txt ] && { cat /tmp/sd/out.txt; echo; exit 0; }; sleep 1; done; echo TIMEOUT
