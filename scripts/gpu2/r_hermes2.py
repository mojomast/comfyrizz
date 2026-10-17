# Runs hermes_shim.py in a fresh interpreter (the exec kernel is persistent).
import subprocess, sys
p=subprocess.run([sys.executable, "/content/hermes_shim.py"], capture_output=True, text=True)
print("\n".join(l for l in (p.stdout+p.stderr).splitlines() if not l.startswith('{"v"'))[-6000:])
