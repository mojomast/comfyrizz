#!/bin/bash
# Hard stop for comfyrizz-gpu2 only, after $1 seconds.
sleep "$1"
echo "$(date) watchdog firing" >> /workspace/comfy-hackathon/test/gpu2/logs/watchdog.log
${COLAB_BIN:-$HOME/.local/bin/colab} stop -s comfyrizz-gpu2 >> /workspace/comfy-hackathon/test/gpu2/logs/watchdog.log 2>&1
${COLAB_BIN:-$HOME/.local/bin/colab} sessions >> /workspace/comfy-hackathon/test/gpu2/logs/watchdog.log 2>&1
