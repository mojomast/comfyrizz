#!/bin/bash
# Hard stop for comfyrizz-willem only, after $1 seconds (session-only; never touches other sessions).
L=/workspace/willem-birthday/logs/watchdog.log
sleep "$1"
echo "$(date) watchdog firing" >> $L
/home/box/.local/bin/colab stop -s comfyrizz-willem >> $L 2>&1
/home/box/.local/bin/colab sessions >> $L 2>&1
