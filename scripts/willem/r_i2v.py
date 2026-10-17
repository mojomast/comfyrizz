import subprocess
print(subprocess.run(["python", "/content/g2_run.py", "/content/jobs/i2v.json"], capture_output=True, text=True).stdout[-6000:])
