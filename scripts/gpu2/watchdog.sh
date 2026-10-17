#!/bin/bash
# Hard stop for comfyrizz-gpu2 only, after $1 seconds.
sleep "$1"
echo "$(date) watchdog firing" >> /workspace/comfy-hackathon/test/gpu2/logs/watchdog.log
/home/box/.local/bin/colab stop -s comfyrizz-gpu2 >> /workspace/comfy-hackathon/test/gpu2/logs/watchdog.log 2>&1
/home/box/.local/bin/colab sessions >> /workspace/comfy-hackathon/test/gpu2/logs/watchdog.log 2>&1
