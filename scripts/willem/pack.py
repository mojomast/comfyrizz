import subprocess, sys
pat = "v_*_r.mp4"
print(subprocess.run(f"cd /content/out && rm -f /content/pack.tgz && tar czf /content/pack.tgz {pat} results.json && ls -la /content/pack.tgz", shell=True, capture_output=True, text=True).stdout)
