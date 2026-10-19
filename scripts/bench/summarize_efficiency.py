"""Reduce archived trial evidence; never sums overlapping account balance deltas."""
import argparse
import csv
import io
import json
from pathlib import Path
import statistics
import zipfile


def summarize(folder, rate):
    run = json.loads((folder / 'run.json').read_text())
    result = {'gpu': run['gpu'], 'ratePerHour': rate, 'lifecycleSeconds': run['lifecycleSeconds'],
              'accountDelta': run['accountDelta'], 'shutdown': run['stopped']['state'], 'error': run.get('error')}
    archive = folder / 'output.zip'
    if not archive.exists():
        return result
    with zipfile.ZipFile(archive) as z:
        names = z.namelist()
        hardware = json.loads(z.read('out/hardware.json')) if 'out/hardware.json' in names else None
        result['hardware'] = hardware
        if 'out/quality.json' in names:
            trials = json.loads(z.read('out/quality.json'))
            batches = {}
            for trial in trials:
                batches.setdefault((trial.get('dataset', 'default'), trial['batch'], trial.get('order', 'original')), []).append(trial)
            result['tts'] = []
            for (dataset, batch, order), trials in sorted(batches.items()):
                seconds = sum(t['seconds'] for t in trials)
                accepted = sum(t['accepted'] for t in trials)
                words = sum(len(o['text'].split()) for t in trials for o in t['outputs'] if o.get('accepted'))
                audio = sum(t['acceptedAudioSeconds'] for t in trials)
                result['tts'].append({'dataset': dataset, 'batch': batch, 'order': order, 'trials': len(trials), 'seconds': [t['seconds'] for t in trials],
                  'meanSeconds': statistics.mean(t['seconds'] for t in trials), 'accepted': accepted,
                  'total': sum(len(t['outputs']) for t in trials), 'meanWer': statistics.mean(t['meanWer'] for t in trials),
                  'acceptedWordsPerSecond': words / seconds, 'acceptedWordsPerUnit': words / (seconds * rate / 3600),
                  'acceptedAudioSecondsPerSecond': audio / seconds,
                  'peakAllocatedGiB': max(t['peakAllocated'] for t in trials) / 2**30,
                  'peakReservedGiB': max(t['peakReserved'] for t in trials) / 2**30})
        elif 'out/trials.json' in names:
            result['graphics'] = json.loads(z.read('out/trials.json'))
        elif 'out/events.jsonl' in names:
            result['partialTrials'] = [e for e in map(json.loads, z.read('out/events.jsonl').decode().splitlines()) if e['phase'] in ['pair', 'trial']]
        if 'out/gpu.csv' in names:
            rows = list(csv.reader(io.StringIO(z.read('out/gpu.csv').decode())))
            samples = []
            for row in rows[1:]:
                try:
                    samples.append([float(v.strip().split()[0]) for v in row[1:]])
                except (ValueError, IndexError):
                    pass
            if samples:
                result['gpuTrace'] = {'samples': len(samples), 'meanGpuPercent': statistics.mean(r[0] for r in samples),
                    'peakUsedMiB': max(r[2] for r in samples), 'meanPowerWatts': statistics.mean(r[3] for r in samples)}
        if 'out/events.jsonl' in names:
            result['remotePhases'] = [e for e in map(json.loads, z.read('out/events.jsonl').decode().splitlines()) if e['phase'] not in ['job', 'trial', 'qa', 'pair']]
        if 'out/setup-events.jsonl' in names:
            result['setupSteps'] = list(map(json.loads, z.read('out/setup-events.jsonl').decode().splitlines()))
    events = [json.loads(line) for line in (folder / 'events.jsonl').read_text().splitlines()]
    result['hostTrials'] = [e for e in events if e.get('phase') in ['transfer_trial', 'overlap_trial']]
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('folder', type=Path)
    parser.add_argument('--rate', type=float, required=True)
    args = parser.parse_args()
    print(json.dumps(summarize(args.folder, args.rate), indent=2))
